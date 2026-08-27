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

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    })

    const sheetDataString = JSON.stringify(sheetData)

    const prompt = `
Please review the attached transcript document and perform the following tasks carefully.

1. Clean the Transcript
Remove any text that is clearly not part of the speaker's actual spoken words, such as transcription artifacts, notes, editing marks, duplicated fragments, incomplete transcription tags, stray characters, or other non-spoken content.
Correct obvious transcription errors, including:
words split incorrectly (e.g., "w-write")
obvious spelling mistakes
obvious grammar or transcription mistakes that make the sentence unreadable
incomplete words caused by transcription issues
Do not rewrite, paraphrase, summarize, or improve the speaker's wording.
Preserve the speaker's original text and phrasing as much as possible.
Only make corrections when the text is clearly incorrect, incomplete, or unintelligible.
Maintain all existing formatting, including colors, highlights, emphasis, headings, spacing, and overall document structure.

2. Separate Content by Speaker
Create a separate document for each speaker.
Each document should contain only the content spoken by that speaker.
Do not mix content from multiple speakers.
Preserve the original order of the speaker's remarks.

3. Speaker and Session Metadata Lookup
Use the worksheet/tab named  ${sheetDataString} as the authoritative source for speaker and session information.
When retrieving the Speaker, Title, Role, and Organization:
Search for the speaker in ${sheetDataString}.
If the speaker name in the transcript does not exactly match the sheet (for example: spelling differences, transcription errors, missing accents, abbreviated names, initials, formatting differences, or slight variations), identify the closest matching speaker and use the information from the sheet.
Standardize the speaker name using the spelling found in the sheet.
Use the corresponding talk title, role, and organization from the same row in the sheet.
If multiple similar names exist, use the transcript content and session context to determine the correct match.
Treat the spreadsheet as the source of truth whenever there is a discrepancy between the transcript and the sheet.
Do not leave speaker information blank because of minor spelling or transcription differences.
If the transcript speaker name is partially incorrect, replace it with the official version from the sheet.
Example:If the transcript contains "Rahul Durega" and the sheet contains "Rahul Dureja", use "Rahul Dureja" and the associated 
session information from the sheet.

4. Add Metadata Header to Each Speaker Document
At the very top of each speaker document, insert the following metadata block.
Formatting requirements:
Font: Roboto
Size: 12 pt
Color: Black
Populate the fields as follows:
ID: talk-XX-singapore26
Use sequential numbering starting from: talk-10-singapore26
Increment the number for each speaker document.
Conference: Apidays Sigapore 2026
Title: Retrieve from  ${sheetDataString}
Display the title in bold.
Speaker: Retrieve from  ${sheetDataString}
Role: Retrieve from  ${sheetDataString}
Organization: Retrieve from  ${sheetDataString}
Date: May 13, 2026
Topics: [Generate topic tags based on the speaker's transcript]
Topic requirements:
Create approximately 10–20 highly relevant searchable topic tags.
Use terms and concepts discussed by the speaker.
Include technologies, methodologies, business concepts, standards, use cases, industries, products, frameworks, and key themes mentioned in the talk.
Prefer concise tags separated by commas.
Do not use generic tags unless they are central to the presentation.
Prioritize terminology that would help someone find this transcript through search.
Example:
ID: talk-10-apidaysny26
Conference: Apidays New York 2026
Title: AI without Integration is Just Talk: How to Scale Agent Connectivity with APIs and MCP
Speaker: Rahul Dureja
Role: Regional Field CTO
Organization: Workato
Date: May 13, 2026
Topics: Agentic AI, MCP, enterprise agents, APIs, API integration, orchestration, governance, observability, trust, control plane, composable capabilities, intent-based APIs, PBCs, system decoupling, production AI agents, security, billing automation
5. Quality Assurance Checklist
Before finalizing each speaker document:
Verify that only the selected speaker's content is included.
Verify that all metadata matches the corresponding ${sheetDataString}.
Verify that speaker names have been standardized using ${sheetDataString} values.
Verify that titles, roles, and organizations come from ${sheetDataString}, not from the transcript.
Verify that all formatting from the source document has been preserved.
Verify that no speaker wording has been unnecessarily rewritten.
Verify that all obvious transcription artifacts have been removed.
Verify that the document remains faithful to the original spoken content.
Verify that the generated topics accurately reflect the content of the speaker's remarks.
Output one clean, finalized document per speaker.`

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
