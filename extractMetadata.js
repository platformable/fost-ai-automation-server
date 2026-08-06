async function extractMetadata(content) {
  try {
    const extractValue = (key) => {
      const regex = new RegExp(`${key}:\\s*(.+)`, "i")
      const match = content.match(regex)
      return match ? match[1].trim() : null
    }

    const rawId = extractValue("ID")
    const conference = extractValue("Conference")
    const title = extractValue("Title")
    const speaker = extractValue("Speaker")
    const role = extractValue("Role")
    const organization = extractValue("Organization")

    // --- CÓDIGO DE FECHA CORREGIDO ---
    const rawDate = extractValue("Date")
    let formattedDate = null

    if (rawDate) {
      const d = new Date(rawDate)
      // Usamos los métodos locales (getFullYear, getMonth, getDate)
      // para evitar que JavaScript nos mueva el día por la zona horaria.
      const year = d.getFullYear()
      const month = String(d.getMonth() + 1).padStart(2, "0") // +1 porque enero es 0
      const day = String(d.getDate()).padStart(2, "0")

      formattedDate = `${year}-${month}-${day}`
    }
    // ---------------------------------

    const rawTopics = extractValue("Topics")
    const topicsArray = rawTopics
      ? rawTopics.split(",").map((topic) => topic.trim())
      : []

    return {
      conference_id: rawId,
      conference: conference,
      title: title,
      speaker: speaker,
      role: role,
      organization: organization,
      date: formattedDate,
      topics: topicsArray,
    }
  } catch (error) {
    console.error("Error procesando el texto:", error)
    return null
  }
}

module.exports = extractMetadata
