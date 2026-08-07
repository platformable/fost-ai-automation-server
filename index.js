const express = require("express")
const multer = require("multer")
const fs = require("fs")
const path = require("path")
require("dotenv").config()

const { GoogleGenerativeAI } = require("@google/generative-ai")
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

aapp.post("/clean-transcription", async (req, res) => {
  console.log("Cleaning transcription request received")

  // 1. Receive sheetData from n8n
  const { fileName, transcriptionText, sheetData } = req.body

  if (!sheetData) {
    return res
      .status(400)
      .json({ error: "Missing sheetData in the request body." })
  }

  try {
    // 2. Force JSON output directly in the model configuration
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      },
    })

    // Convert the sheet array into a string so Gemini can read it
    const sheetDataString = JSON.stringify(sheetData)

    const prompt = `Please review the attached transcript and perform the following tasks carefully.

1. Clean the Transcript
- Remove any text that is clearly not part of the speaker's actual spoken words (transcription artifacts, notes, editing marks, stray characters).
- Correct obvious transcription errors, including split words, spelling mistakes, and grammar issues that make the sentence unreadable.
- Do NOT rewrite, paraphrase, summarize, or improve the speaker's wording. Preserve the original phrasing.

2. Separate Content by Speaker & Match Metadata
- Identify each speaker in the transcript.
- Use the provided JSON data representing the "French Forum 1" spreadsheet to find the matching speaker.
- If the transcript speaker name has minor spelling differences, missing accents, or initials, find the closest match in the spreadsheet and use the OFFICIAL spreadsheet name.

3. Generate Topics
- Create 10-20 highly relevant, searchable topic tags for each speaker based on their segment.
- Use terms and concepts discussed (technologies, methodologies, etc.).

4. OUTPUT FORMAT
You must return the response SOLELY and EXCLUSIVELY as a valid JSON array of objects.
Do not output standard text documents. The JSON object for each speaker will act as their "document".

Here is the Reference Spreadsheet Data (Source of Truth):
${sheetDataString}

The JSON schema must strictly follow this structure:
[
  {
    "id": "talk-XX-apidaysny26", 
    "speaker": "Official Name from Spreadsheet",
    "metadata": {
      "conference": "Apidays New York 2026",
      "date": "May 13, 2026",
      "title": "Talk Title from Spreadsheet",
      "role": "Role from Spreadsheet",
      "organization": "Organization from Spreadsheet",
      "topics": ["Topic 1", "Topic 2", "Topic 3"]
    },
    "cleaned_content": "The fully cleaned, direct text."
  }
]`

    // Send both the transcript and the prompt
    const result = await model.generateContent([
      { text: `TRANSCRIPT TO CLEAN:\n${transcriptionText}` },
      { text: prompt },
    ])

    const cleanedTranscriptionText = result.response.text()
    console.log("Transcription cleaning completed")

    // Parse the JSON string from Gemini into an actual JavaScript object
    const finalData = JSON.parse(cleanedTranscriptionText)

    res.json({
      success: true,
      fileName: `cleaned_transcription_${fileName}.json`,
      data: finalData,
    })
  } catch (error) {
    console.error("Error during the cleaning process:", error)
    res
      .status(500)
      .json({ error: "An error occurred while cleaning the transcription." })
  }
})
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Transcription server running at http://localhost:${PORT}`)
})
