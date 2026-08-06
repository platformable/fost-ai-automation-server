const dotenv = require("dotenv")
const { GoogleGenAI } = require("@google/genai")
const fs = require("node:fs")

dotenv.config()
async function listarModelos() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
  const response = await fetch(url)
  const data = await response.json()

  console.log("🔥 Modelos disponibles AHORA MISMO:")
  const modelosDeTexto = data.models.filter((m) =>
    m.supportedGenerationMethods.includes("generateContent"),
  )
  modelosDeTexto.forEach((m) =>
    console.log(`- ${m.name.replace("models/", "")}`),
  )
}

listarModelos()
