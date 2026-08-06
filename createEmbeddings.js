const { pipeline } = require("@xenova/transformers")
const db = require("./dbConnection")

let extractorInstance = null

const createEmbeddings = async (chunks) => {
  if (!extractorInstance) {
    console.log("Cargando modelo de embeddings...")
    extractorInstance = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    )
  }

  for (const chunk of chunks) {
    try {
      const output = await extractorInstance(chunk.pageContent, {
        pooling: "mean",
        normalize: true,
      })

      const embedding = Array.from(output.data)

      const embeddingString = JSON.stringify(embedding)

      console.log(`Intentando guardar chunk: ${chunk.id}`)

      await db.query(
        `INSERT INTO conference_chunks (id, content, metadata, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (id) DO UPDATE SET 
            embedding = EXCLUDED.embedding,
            content = EXCLUDED.content,
            metadata = EXCLUDED.metadata`,
        [chunk.id, chunk.pageContent, chunk.metadata, embeddingString],
      )

      console.log(`✅ Chunk guardado correctamente: ${chunk.id}`)
    } catch (error) {
      // Si la base de datos rechaza el vector, lo veremos aquí
      console.error(`❌ Error al guardar el chunk ${chunk.id}:`, error.message)
    }
  }
}

module.exports = createEmbeddings
