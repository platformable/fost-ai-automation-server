const dotenv = require("dotenv")
const { GoogleGenAI } = require("@google/genai")
const fs = require("node:fs")

dotenv.config()

async function main() {
  // Inicializa el cliente (tomará GEMINI_API_KEY del entorno automáticamente)
  const ai = new GoogleGenAI({})

  // 1. Cargar el audio en memoria
  const audioBase64 = fs.readFileSync("./french2_0450/french2_0450_7.mp3", {
    encoding: "base64",
  })

  try {
    // 2. Usar generateContent para pedirle al modelo que transcriba
    const response = await ai.models.generateContent({
      /* model: "gemini-3.5-flash", */
      model: "gemini-flash-latest",
      contents: [
        {
          inlineData: {
            mimeType: "audio/mpeg",
            data: audioBase64,
          },
        },

        "Transcribe este audio palabra por palabra. Mantén la puntuación correcta y la jerga técnica tal como se pronuncia.Separe las oraciones en párrafos y agrega saltos de línea. No agregues comentarios ni explicaciones. Devuelve solo la transcripción en texto plano.",
      ],
    })

    const transcription = response.text
    fs.writeFileSync("./french2_0450/french2_0450_7.txt", transcription, {
      encoding: "utf-8",
    })
    console.log("Transcripción completada:")

    //console.log(response.text)
  } catch (error) {
    console.error("Error al transcribir:", error)
  }
}

main()
