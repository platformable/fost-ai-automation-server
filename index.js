const express = require("express")
const multer = require("multer")
const fs = require("fs")
const path = require("path")
require("dotenv").config()

const { GoogleGenerativeAI } = require("@google/generative-ai")
const { GoogleAIFileManager } = require("@google/generative-ai/server")

const app = express()

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
  const { fileName, transcriptionText } = req.body

  console.log(`Cleaning transcription for file: ${fileName}`)
  try {
    if (!req.files || req.files.length === 0) {
      return res
        .status(400)
        .json({ error: "No se recibió ningún archivo de transcripción." })
    }

    /* const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" })

    const prompt = `You are a professional transcription and document processing assistant.
Your task is to clean up the provided transcription text. Follow these strict rules to ensure high quality:

NO DUPLICATION / NO LOOPING: Process the content strictly in chronological/sequential order. Never repeat a section, paragraph, phrase, or timestamp that has already been included. Ensure every part of the transcription appears exactly once.
CONTINUOUS FLOW: Maintain a clean, linear flow from the beginning of the text to the end without resetting or looping back to previous timestamps or topics.
ACCURACY: Preserve technical terms, speaker names, numbers, and stats accurately.
TRANSCRIPTION STYLE: Clean up verbal stutters/      false starts if requested, but do not omit unique content.

Deliver a single, complete, non-repetitive transcript from start to finish.`

    const result = await model.generateContent([
      { text: transcriptionText },
      { text: prompt },
    ])

    const cleanedTranscriptionText = result.response.text()
    console.log("Transcription cleaning completed") */

    res.json({
      success: true,
      // fileName: `transcripcion_limpia_${fileName}.txt`,
      // cleanedTranscription: cleanedTranscriptionText,
    })
  } catch (error) {
    console.error("Error during the cleaning process:", error)
    res
      .status(500)
      .json({ error: "Ocurrió un error al limpiar la transcripción." })
  }
})
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Transcription server running at http://localhost:${PORT}`)
})
