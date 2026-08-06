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

    const prompt = `Generate a detailed and accurate transcription of this audio file in English. 
        The audio is about 9 hours long but contains many silences. 
        Skip the silences and structure the text with clear paragraphs. If there are multiple speakers, try to separate them by turns.`

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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Transcription server running at http://localhost:${PORT}`)
})
