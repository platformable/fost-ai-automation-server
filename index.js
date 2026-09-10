const express = require("express")
const multer = require("multer")
const fs = require("fs")
const path = require("path")
require("dotenv").config()
const { Agent, setGlobalDispatcher } = require("undici")

setGlobalDispatcher(
  new Agent({
    headersTimeout: 1200000,
    bodyTimeout: 1200000,
  }),
)

const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai")
const { GoogleAIFileManager } = require("@google/generative-ai/server")

const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const upload = multer({ dest: "uploads/" })

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY)

app.post("/transcribe", upload.any(), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res
        .status(400)
        .json({ error: "No se recibió ningún archivo de audio." })
    }

    const uploadedFile = req.files[0]

    const localFilePath = uploadedFile.path
    const mimeType = uploadedFile.mimetype
    console.log(`Subiendo archivo a Gemini... (${uploadedFile.originalname})`)

    const uploadResponse = await fileManager.uploadFile(localFilePath, {
      mimeType: mimeType,
      displayName: uploadedFile.originalname,
    })
    console.log(`Archivo subido con éxito: ${uploadResponse.file.uri}`)

    console.log("Generando transcripción. Esto puede tomar unos minutos...")

    let fileState = uploadResponse.file
    while (fileState.state === "PROCESSING") {
      console.log("Archivo aún procesándose, esperando 10s...")
      await new Promise((resolve) => setTimeout(resolve, 10000))
      fileState = await fileManager.getFile(uploadResponse.file.name)
    }

    if (fileState.state === "FAILED") {
      throw new Error("El procesamiento del archivo en Gemini falló.")
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" })

    const prompt = ` You are a professional transcription and document processing assistant.
        The audio could be about 9 hours long but contains many silences. 
      
Your task is to transcribe the  audio accurately. Follow these strict rules to ensure high quality:

NO DUPLICATION / NO LOOPING: Process the content strictly in chronological/sequential order. Never repeat a section, paragraph, phrase, or timestamp that has already been included. Ensure every part of the transcription appears exactly once.
CONTINUOUS FLOW: Maintain a clean, linear flow from the beginning of the audio/text to the end without resetting or looping back to previous timestamps or topics.
ACCURACY: Preserve technical terms, speaker names, numbers, and stats accurately.
TRANSCRIPTION STYLE: Clean up verbal stutters/false starts if requested, but do not omit unique content.

Deliver a single, complete, non-repetitive transcript from start to finish.`

    const result = await model.generateContentStream([
      {
        fileData: {
          mimeType: uploadResponse.file.mimeType,
          fileUri: uploadResponse.file.uri,
        },
      },
      { text: prompt },
    ])

    let transcriptionText = ""
    for await (const chunk of result.stream) {
      const chunkText = chunk.text()
      transcriptionText += chunkText
    }

    console.log("Transcription completed")
    fs.unlinkSync(localFilePath)

    res.json({
      success: true,
      fileName: `transcripcion_${uploadedFile.originalname}.txt`,
      transcription: transcriptionText,
    })
  } catch (error) {
    console.error("Error durante el proceso:", error)
    console.error("Causa:", error.cause)
    res.status(500).json({
      error: "Ocurrió un error al procesar la transcripción.",
      details: error.message,
      cause: error.cause,
    })
  }
})

app.post("/clean-transcription", async (req, res) => {
  console.log("Cleaning transcription request received (Plain-Text Mode)")
  const { fileName, transcriptionText, sheetData } = req.body

  if (!sheetData) {
    return res
      .status(400)
      .json({ error: "Missing sheetData in the request body." })
  }

  try {
    const sheetDataString = JSON.stringify(sheetData)

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      systemInstruction: `You are a strict verbatim transcript editor.
CRITICAL DIRECTIVES:
1. NEVER summarize, condense, paraphrase, or rewrite.
2. Every spoken sentence must remain 100% complete in the final document.
3. Your ONLY allowed edits are removing filler words (e.g., "um", "uh", "like") and fixing obvious transcription glitches.`,
      generationConfig: {
        temperature: 0.0,
      },
    })

    const prompt = `
Execute the following workflow on the transcript.

### INPUT DATA:
- Metadata Source of Truth: ${sheetDataString}
- Raw Transcript:
${transcriptionText}

### INSTRUCTIONS:
1. Separate content by speaker, keeping chronological order.
2. Clean the text verbatim (remove filler words/typos). DO NOT SUMMARIZE.
3. Lookup the official speaker name, title, role, and organization from the Source of Truth.

### OUTPUT FORMAT:
You MUST output the result for each speaker using EXACTLY the following structure. Do not output JSON.

===START_SPEAKER===
ID: [Generate sequential ID starting from talk-10-singapore26]
Conference: Apidays Singapore 2026
Title: [Matched Title]
Speaker: [Matched Name]
Role: [Matched Role]
Organization: [Matched Org]
Date: May 13, 2026
Topics: [10-20 comma-separated tags]
===CONTENT_START===
[FULL VERBATIM CLEANED TRANSCRIPT HERE]
===END_SPEAKER===
`

    const result = await model.generateContent(prompt)
    const rawOutput = result.response.text()

    const finalData = []
    const speakerBlocks = rawOutput
      .split("===START_SPEAKER===")
      .filter((b) => b.trim())

    for (const block of speakerBlocks) {
      const endCleaned = block.split("===END_SPEAKER===")[0].trim()
      const parts = endCleaned.split("===CONTENT_START===")
      if (parts.length < 2) continue

      const headerPart = parts[0].trim()
      const content = parts.slice(1).join("===CONTENT_START===").trim()

      const headerLines = headerPart.split("\n")

      const metadata = {}
      let id = "",
        speakerName = ""

      headerLines.forEach((line) => {
        const match = line.match(/^([^:]+):\s*(.*)$/)
        if (match) {
          const key = match[1].trim().toLowerCase()
          const value = match[2].trim()

          if (key === "id") id = value
          else if (key === "speaker") speakerName = value
          else if (key === "topics")
            metadata.topics = value.split(",").map((t) => t.trim())
          else metadata[key] = value
        }
      })

      if (speakerName && content) {
        finalData.push({
          id: id,
          speaker: speakerName,
          metadata: metadata,
          cleaned_content: content,
        })
      }
    }

    console.log("Transcription cleaning and parsing completed.")

    res.json({
      success: true,
      fileName: `cleaned_transcription_${fileName}.json`,
      data: finalData,
    })
  } catch (error) {
    console.error("Error during the cleaning process:", error)
    res.status(500).json({
      error: "An error occurred while cleaning the transcription.",
      details: error.message,
    })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Transcription server running at http://localhost:${PORT}`)
})
