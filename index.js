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
  console.log("Cleaning transcription request received")
  const { fileName, transcriptionText, sheetData } = req.body

  if (!sheetData) {
    return res
      .status(400)
      .json({ error: "Missing sheetData in the request body." })
  }

  try {
    const sheetDataString = JSON.stringify(sheetData)

    // =========================================================================
    // STEP 1: Extract Speakers & Metadata (JSON Mode)
    // =========================================================================
    console.log("Step 1: Segmenting speakers and extracting metadata...")

    const step1Schema = {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          id: { type: SchemaType.STRING },
          speaker: { type: SchemaType.STRING },
          metadata: {
            type: SchemaType.OBJECT,
            properties: {
              conference: { type: SchemaType.STRING },
              date: { type: SchemaType.STRING },
              title: { type: SchemaType.STRING },
              role: { type: SchemaType.STRING },
              organization: { type: SchemaType.STRING },
              topics: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
              },
            },
          },
          raw_content: { type: SchemaType.STRING },
        },
        required: ["id", "speaker", "metadata", "raw_content"],
      },
    }

    const metadataModel = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.0,
        responseMimeType: "application/json",
        responseSchema: step1Schema,
      },
    })

    const step1Prompt = `
Analyze the transcript below and match speakers against the dataset: ${sheetDataString}.

TASKS:
1. Identify all speakers in the transcript.
2. Match each speaker to ${sheetDataString} to pull their official name, title, role, and organization.
3. Group the raw, unedited spoken text belonging to each speaker into "raw_content". Copy the exact raw text segments from the transcript without shortening or summarizing.
4. Generate 10-20 relevant topic tags for each speaker.
5. Set 'id' sequentially as "talk-10-singapore26", "talk-11-singapore26", etc.
6. Set 'conference' to "Apidays Singapore 2026" and 'date' to "May 13, 2026".

TRANSCRIPT:
${transcriptionText}
`

    const step1Result = await metadataModel.generateContent(step1Prompt)
    let speakerSegments = JSON.parse(step1Result.response.text())

    // Deduplicate / merge segments by speaker if split
    const mergedMap = new Map()
    for (const item of speakerSegments) {
      const key = (item.speaker || "").trim().toLowerCase()
      if (!key) continue
      if (mergedMap.has(key)) {
        const existing = mergedMap.get(key)
        existing.raw_content += "\n\n" + item.raw_content
      } else {
        mergedMap.set(key, item)
      }
    }
    speakerSegments = Array.from(mergedMap.values())

    // =========================================================================
    // STEP 2: Clean Each Speaker's Text Verbatim (Plain Text Mode)
    // =========================================================================
    console.log(
      `Step 2: Cleaning verbatim text for ${speakerSegments.length} speakers...`,
    )

    const cleanerModel = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: `You are a strict verbatim transcript editor.
Your ONLY job is to remove filler words (e.g., "um", "uh", "you know", "like") and fix obvious transcription typos/glitches.

CRITICAL RULES:
- DO NOT summarize, condense, paraphrase, or delete any sentences.
- Preserve 100% of the original text length, structure, and phrasing.
- Return ONLY the cleaned text. Do NOT add commentary, headers, or markdown wrappers.`,
      generationConfig: {
        temperature: 0.0, // Plain text mode — avoids JSON string compression
      },
    })

    const finalData = []

    for (const segment of speakerSegments) {
      console.log(
        `Cleaning transcript verbatim for speaker: ${segment.speaker}...`,
      )

      const cleanPrompt = `Remove filler words and fix typos in the following transcript verbatim. Do NOT summarize or delete any sentences:\n\n${segment.raw_content}`

      const cleanResult = await cleanerModel.generateContent(cleanPrompt)
      const cleanedText = cleanResult.response.text().trim()

      finalData.push({
        id: segment.id,
        speaker: segment.speaker,
        metadata: segment.metadata,
        cleaned_content: cleanedText,
      })
    }

    console.log("Transcription cleaning completed successfully.")

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
