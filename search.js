// search.js
require("dotenv").config()
const { pipeline } = require("@xenova/transformers")
const db = require("./dbConnection")

// -----------------------------------------
// Configuración PostgreSQL
// -----------------------------------------

// -----------------------------------------
// Cargar el modelo UNA sola vez
// -----------------------------------------

console.log("Cargando modelo de embeddings...")

console.log("Modelo cargado.")

// -----------------------------------------
// Buscar
// -----------------------------------------

async function search(question, limit = 5) {
  let extractorInstance = null

  async function getExtractor() {
    if (!extractorInstance) {
      console.log("Cargando modelo...")
      extractorInstance = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
      )
    }

    return extractorInstance
  }
  const extractor = await getExtractor()

  const output = await extractor(question, {
    pooling: "mean",
    normalize: true,
  })

  const embedding = Array.from(output.data)

  const embeddingString = JSON.stringify(embedding)
  // Buscar en PostgreSQL

  const result = await db.query(
    `
SELECT
    id,
    content,
    metadata,
    embedding <=> $1::vector AS distance

FROM conference_chunks

ORDER BY embedding <=> $1::vector

LIMIT $2
`,
    [embeddingString, limit],
  )

  return result.rows
}

// -----------------------------------------
// Main
// -----------------------------------------

async function main() {
  await db.connect()

  const question = "what does Cristina says about AI?"

  const results = await search(question)

  console.log("\nResultados encontrados:\n")

  for (const row of results) {
    console.log("------------------------------------")

    console.log("ID:", row.id)

    console.log("Speaker:", row.metadata.speaker)

    console.log("Distance:", row.distance)

    console.log("Content:", row.content)

    console.log("\n")
  }

  await db.end()
}

main().catch(console.error)
