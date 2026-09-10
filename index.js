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
    const responseSchema = {
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
          cleaned_content: { type: SchemaType.STRING },
        },
        required: ["id", "speaker", "metadata", "cleaned_content"],
      },
    }

    // 1. ADD SYSTEM INSTRUCTION & SET TEMPERATURE TO 0 HERE
    // Switch model to gemini-2.5-pro for strict verbatim compliance inside JSON
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      systemInstruction: `You are an expert verbatim transcript editor.

CRITICAL JSON FIELD INSTRUCTION:
- The "cleaned_content" JSON field MUST contain the FULL, VERBATIM transcript for that speaker.
- NEVER summarize, condense, paraphrase, or truncate "cleaned_content".
- Do NOT reduce paragraphs to short sentences or bullet points.
- Preserve 100% of the speaker's thoughts, details, and sentences.
- Your ONLY allowed edits to the spoken text are removing filler words ("um", "uh", "you know", "like") and fixing obvious transcription glitches.`,
      generationConfig: {
        temperature: 0.0,
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    })

    const sheetDataString = JSON.stringify(sheetData)

    // 2. USER PROMPT FOCUSES ON THE INPUT DATA & WORKFLOW
    const prompt = `
Execute the following tasks on the provided transcript.

### INPUT DATA:
- Metadata Source of Truth: ${sheetDataString}
- Raw Transcript:
${transcriptionText}

---

### WORKFLOW:

1. CLEAN TRANSCRIPT (VERBATIM ONLY)
- Remove filler words ("um", "uh", "you know", "like") and non-spoken artifacts (stray characters, editing notes, split-word glitches like "w-write").
- Fix obvious spelling glitches that make sentences unreadable.
- DO NOT summarize, paraphrase, or delete spoken sentences. Preserve original phrasing completely.

2. SEPARATE BY SPEAKER
- Group content by speaker into distinct array items.
- Maintain original chronological order of remarks for each speaker.

3. METADATA LOOKUP & STANDARDIZATION
- Match the speaker name against the authoritative dataset: ${sheetDataString}.
- Standardize the speaker name, talk title, role, and organization using values from ${sheetDataString}.
- Use ${sheetDataString} as the source of truth whenever there is a discrepancy.

4. METADATA VALUES TO SET:
- id: Sequential numbering format "talk-XX-singapore26" starting from "talk-10-singapore26" (e.g. talk-10-singapore26, talk-11-singapore26).
- conference: "Apidays Singapore 2026"
- date: Strictly set to "May 13, 2026"
- topics: Generate 10–20 comma-separated, highly specific technical/business topic tags based on the talk content.
`

    const result = await model.generateContent(prompt)

    const cleanedTranscriptionText = result.response.text()
    console.log("Transcription cleaning completed")

    let finalData = JSON.parse(cleanedTranscriptionText)

    // --- Safety net: dedupe + merge by speaker in case the model splits someone into multiple objects ---
    const originalCount = finalData.length
    const mergedBySpeaker = new Map()

    for (const entry of finalData) {
      const key = (entry.speaker || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")

      if (!key) continue

      if (mergedBySpeaker.has(key)) {
        const existing = mergedBySpeaker.get(key)
        existing.cleaned_content =
          `${existing.cleaned_content} ${entry.cleaned_content}`.trim()
        const existingTopics = existing.metadata?.topics || []
        const newTopics = entry.metadata?.topics || []
        existing.metadata.topics = [
          ...new Set([...existingTopics, ...newTopics]),
        ]
        existing.metadata = {
          ...entry.metadata,
          ...existing.metadata,
          topics: existing.metadata.topics,
        }
      } else {
        mergedBySpeaker.set(key, entry)
      }
    }

    finalData = Array.from(mergedBySpeaker.values())

    if (finalData.length !== originalCount) {
      console.warn(
        `⚠️ Speaker dedupe kicked in for "${fileName}": model returned ${originalCount} objects, merged down to ${finalData.length}.`,
      )
    }

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
