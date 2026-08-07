const express = require("express")
const multer = require("multer")
const fs = require("fs")
const path = require("path")
require("dotenv").config()

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
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" })

    const prompt = ` You are a professional transcription and document processing assistant.
        The audio could be about 9 hours long but contains many silences. 
      
Your task is to transcribe the  audio accurately. Follow these strict rules to ensure high quality:

NO DUPLICATION / NO LOOPING: Process the content strictly in chronological/sequential order. Never repeat a section, paragraph, phrase, or timestamp that has already been included. Ensure every part of the transcription appears exactly once.
CONTINUOUS FLOW: Maintain a clean, linear flow from the beginning of the audio/text to the end without resetting or looping back to previous timestamps or topics.
ACCURACY: Preserve technical terms, speaker names, numbers, and stats accurately.
TRANSCRIPTION STYLE: Clean up verbal stutters/false starts if requested, but do not omit unique content.

Deliver a single, complete, non-repetitive transcript from start to finish.`

    const result = await model.generateContent([
      {
        fileData: {
          mimeType: uploadResponse.file.mimeType,
          fileUri: uploadResponse.file.uri,
        },
      },
      { text: prompt },
    ])

    const transcriptionText = result.response.text()
    console.log("Transcription completed")
    fs.unlinkSync(localFilePath)

    res.json({
      success: true,
      fileName: `transcripcion_${uploadedFile.originalname}.txt`,
      transcription: transcriptionText,
    })
  } catch (error) {
    console.error("Error durante el proceso:", error)
    res
      .status(500)
      .json({ error: "Ocurrió un error al procesar la transcripción." })
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

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    })

    const sheetDataString = JSON.stringify(sheetData)

    const prompt = `Please review the attached transcript and perform the following tasks carefully, IN THIS ORDER.

STEP 1 - Identify speakers from the TRANSCRIPT ONLY
- Read the transcript and determine how many DISTINCT people actually speak (e.g. host + 1 guest = 2 speakers).
- Do NOT use the spreadsheet data to decide who the speakers are. The spreadsheet is only used later, for metadata lookup.
- The number of objects you return MUST equal the number of distinct speakers you found in the transcript. If there are 2 people speaking, return exactly 2 objects. Never generate one object per spreadsheet row.
- Only include people who have actual spoken lines transcribed as their own turn. Do NOT include people who are merely mentioned, thanked, or referenced by others but never speak themselves.

STEP 2 - Clean the transcript
- Remove any text that is clearly not part of the speaker's actual spoken words (filler noise, transcription artifacts).
- Correct obvious transcription errors, including split words and spelling mistakes.
- Do NOT rewrite, paraphrase, summarize, or improve the speaker's wording.

STEP 3 - Aggregate content per speaker
- CRITICAL: If a speaker talks multiple times throughout the transcript, merge ALL of their segments into ONE single "cleaned_content" string, in chronological order.
- Never create two objects for the same person. One object = one unique person.
- Do not create objects for people who are mentioned but never speak. Only include speakers with actual spoken lines.
- Do not invent, guess, or modify last names. If a speaker's last name is not clear in the transcript, leave it blank or null.
- Do not create objects for "host" or "moderator".

STEP 4 - Match metadata using the spreadsheet (source of truth for METADATA ONLY)
- For each speaker identified in STEP 1, look up their matching row in the spreadsheet data below to fill in "metadata" (conference, date, title, role, organization).
- Match by name similarity. Do NOT invent, guess, or modify last names.
- If a speaker from the transcript has no match in the spreadsheet, still include them with whatever metadata fields you can infer as null/empty, but do NOT skip them and do NOT add extra people who are in the spreadsheet but don't appear in the transcript.

STEP 5 - Generate topics
- Create 10-20 highly relevant, searchable topic tags for each speaker based on their actual spoken content.

- Only include people who have actual spoken lines transcribed as their own turn. Do NOT include people who are merely mentioned, thanked, or referenced by others but never speak themselves.

- do not include Host/Moderator or unknown speakers in the final output. Only include speakers with actual spoken lines.

Here is the Reference Spreadsheet Data (for metadata matching only, NOT for determining who the speakers are):
${sheetDataString}`

    const result = await model.generateContent([
      { text: `TRANSCRIPT TO CLEAN:\n${transcriptionText}` },
      { text: prompt },
    ])

    const cleanedTranscriptionText = result.response.text()
    console.log("Transcription cleaning completed")

    let finalData = JSON.parse(cleanedTranscriptionText)

    // --- Safety net: dedupe + merge by speaker in case the model still splits someone into multiple objects ---
    const originalCount = finalData.length
    const mergedBySpeaker = new Map()

    for (const entry of finalData) {
      // Normalize name for matching (lowercase, trim, collapse spaces)
      const key = (entry.speaker || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")

      if (!key) continue // skip entries with no speaker name at all

      if (mergedBySpeaker.has(key)) {
        const existing = mergedBySpeaker.get(key)
        // Merge cleaned_content chronologically
        existing.cleaned_content =
          `${existing.cleaned_content} ${entry.cleaned_content}`.trim()
        // Merge topics without duplicates
        const existingTopics = existing.metadata?.topics || []
        const newTopics = entry.metadata?.topics || []
        existing.metadata.topics = [
          ...new Set([...existingTopics, ...newTopics]),
        ]
        // Fill in any missing metadata fields from the duplicate, if the first one had them empty
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
        `⚠️ Speaker dedupe kicked in for "${fileName}": model returned ${originalCount} objects, merged down to ${finalData.length}. Check the transcript/prompt if this keeps happening.`,
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
