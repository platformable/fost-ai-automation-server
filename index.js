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

app.post("/clean-transcription", async (req, res) => {
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

    const prompt = `Please review the attached transcript document and perform the following tasks carefully.
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

3.Standardize the speaker name using the spelling found in the ${sheetDataString}
Use the corresponding talk title, role, and organization from the same row in the sheet.
If multiple similar names exist, use the transcript content and session context to determine the correct match.
Treat the spreadsheet as the source of truth whenever there is a discrepancy between the transcript and the sheet.
Do not leave speaker information blank because of minor spelling or transcription differences.
If the transcript speaker name is partially incorrect, replace it with the official version from the sheet.
Example:If the transcript contains "Rahul Durega" and the sheet contains "Rahul Dureja", use "Rahul Dureja" and the associated session information from the sheet.

4. Quality Assurance Checklist
Before finalizing each speaker document:
Verify that only the selected speaker's content is included.
Verify that all metadata matches the corresponding row in the French Forum 1 (91 PAX) sheet.
Verify that speaker names have been standardized using the spreadsheet values.
Verify that titles, roles, and organizations come from the spreadsheet, not from the transcript.
Verify that all formatting from the source document has been preserved.
Verify that no speaker wording has been unnecessarily rewritten.
Verify that all obvious transcription artifacts have been removed.
Verify that the document remains faithful to the original spoken content.
Verify that the generated topics accurately reflect the content of the speaker's remarks.
Output one clean, finalized document per speaker.

5. OUTPUT FORMAT
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

    const sanitizeJSONString = (rawString) => {
      return rawString.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    }

    const sanitizedText = sanitizeJSONString(cleanedTranscriptionText)
    let finalData
    try {
      finalData = JSON.parse(sanitizedText)
    } catch (parseError) {
      console.error("JSON Parse Error. Texto recibido:", sanitizedText)

      return res.status(500).json({
        error: "El modelo devolvió un JSON inválido.",
        details: parseError.message,
      })
    }

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
