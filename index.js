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

    const prompt = `Please review the attached transcript and perform the following tasks carefully.

1. Clean the Transcript
- Remove any text that is clearly not part of the speaker's actual spoken words.
- Correct obvious transcription errors, including split words and spelling mistakes.
- Do NOT rewrite, paraphrase, summarize, or improve the speaker's wording.

2. Separate Content by Speaker & Match Metadata
- Identify each speaker in the transcript.
- CRITICAL - AGGREGATE CONTENT: If a speaker speaks multiple times, combine all of their spoken segments into ONE SINGLE string for that speaker. Do not create duplicate objects.
- STRICT MATCHING: Use the provided JSON spreadsheet data as the absolute source of truth. 
- DO NOT invent, guess, or modify last names. 

3. Generate Topics
- Create 10-20 highly relevant, searchable topic tags for each speaker.

Here is the Reference Spreadsheet Data (Source of Truth):
${sheetDataString}`

    const result = await model.generateContent([
      { text: `TRANSCRIPT TO CLEAN:\n${transcriptionText}` },
      { text: prompt },
    ])

    const cleanedTranscriptionText = result.response.text()
    console.log("Transcription cleaning completed")

    const finalData = JSON.parse(cleanedTranscriptionText)

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
