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

app.post("/transcribe", upload.single("audioFile"), async (req, res) => {
  console.log("File received:", req.file ? req.file.originalname : "None")
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No se recibió ningún archivo de audio." })
    }

    const localFilePath = req.file.path
    const mimeType = req.file.mimetype
    console.log(`Uploading to Gemini... (${req.file.originalname})`)

    const uploadResponse = await fileManager.uploadFile(localFilePath, {
      mimeType: mimeType,
      displayName: req.file.originalname,
    })
    console.log(`File uploaded successfully: ${uploadResponse.file.uri}`)

    console.log("Transcribing...")
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" })

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

    const outputFileName = `transcripcion_${Date.now()}.txt`
    const outputPath = path.join(__dirname, outputFileName)
    fs.writeFileSync(outputPath, transcriptionText)
    console.log(`Transcription saved to: ${outputFileName}`)

    fs.unlinkSync(localFilePath)

    res.json({
      success: true,
      message: "Complete transcription generated successfully.",
      file: outputFileName,
      preview: transcriptionText.substring(0, 500) + "...",
    })
  } catch (error) {
    console.error("Error occurred:", error)
    res
      .status(500)
      .json({ error: "An error occurred while processing the transcription." })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Transcription server running at http://localhost:${PORT}`)
})
