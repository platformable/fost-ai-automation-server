// Si usas CommonJS, cambia a: const { RecursiveCharacterTextSplitter } = require("@langchain/textsplitters");
const { RecursiveCharacterTextSplitter } = require("@langchain/textsplitters")
const fs = require("node:fs")

async function procesarYAgregarMetadata() {
  const textoConferencia = fs.readFileSync("./french1/cristina.txt", {
    encoding: "utf-8",
  })

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  })

  // 1. Dejamos el arreglo de metadata vacío en este paso
  const fragmentosSinMetadata = await splitter.createDocuments([
    textoConferencia,
  ])

  const metadataBase = {
    conference_id: "talk-01-apidaysny26",
    conference: "Apidays New York 2026",
    speaker: "Cristina Flaschen",
    role: "CEO/Founder",
    organization: "Pandium",
    date: "May 13, 2026",
    topics: [
      "API pragmatism",
      "AI and MCP hype critique",
      "MCP fundamentals",
      "MCP vs APIs",
      "software integration evolution",
      "user-centered design",
      "enterprise AI adoption",
      "MCP limitations",
      "agentic systems UX",
      "authentication and security (OAuth, tokens)",
      "data quality and governance",
      "system reliability and error handling",
      "MCP gateway / agent fabric",
      "platform economics and token costs",
      "integration architecture decisions",
    ],
  }

  // 3. Mapeamos el resultado para inyectar la metadata y el índice autoincremental
  const fragmentosListos = fragmentosSinMetadata.map((fragmento, index) => {
    return {
      ...fragmento,
      id: `talk-01-apidaysny26-cristina-flaschen-${index + 1}`,
      metadata: {
        ...metadataBase, // Copiamos toda la metadata base
        chunk_index: index + 1, // Autoincrementable: empieza en 1, luego 2, 3...
      },
    }
  })

  // 4. Verificamos el resultado
  console.log(fragmentosListos)

  console.log("Transcripción completada:")

  // Salida esperada: { ..., chunk_index: 1 }
  /* 
  console.log(fragmentosListos[1].metadata)
  // Salida esperada: { ..., chunk_index: 2 } */
}

procesarYAgregarMetadata()
