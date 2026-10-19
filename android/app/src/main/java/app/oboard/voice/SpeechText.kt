package app.oboard.voice

/**
 * Makes model text sound right when spoken: no markdown symbols read aloud, no raw URLs, expanded abbreviations.
 */
object SpeechText {
    private val urls = Regex("""https?://\S+""")
    private val md = Regex("""[*_`#>~]|\[(.*?)]\((.*?)\)""")
    private val emoji = Regex("[\\x{1F300}-\\x{1FAFF}\\x{2600}-\\x{27BF}\\x{FE0F}]")
    private val spaces = Regex("""\s+""")

    fun clean(s: String): String {
        var t = s.replace(urls, "a link")
        t = md.replace(t) { m -> m.groups[1]?.value ?: "" }
        t = t.replace(emoji, "")
        t = t.replace(" & ", " and ").replace("e.g.", "for example").replace("i.e.", "that is").replace("etc.", "and so on")
            .replace("→", " to ").replace("->", " to ").replace(" w/ ", " with ").replace("%", " percent").replace("…", "...")
            .replace("—", ", ").replace(" – ", ", ")
        return t.replace(spaces, " ").trim()
    }
}

/**
 * Turns a stream of text deltas into speakable chunks. The first chunk is released early (at a comma once it is a
 * few words long) so speech starts while the model is still writing; after that, whole sentences sound more natural.
 */
class SentenceSplitter {
    private val buf = StringBuilder()
    private var emitted = 0
    private val abbreviations = setOf("mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "approx", "no", "fig")

    fun feed(delta: String): List<String> {
        buf.append(delta)
        val out = mutableListOf<String>()
        while (true) {
            val cut = findCut() ?: break
            val piece = buf.substring(0, cut).trim()
            buf.delete(0, cut)
            if (piece.isNotEmpty()) { out += piece; emitted++ }
        }
        return out
    }

    fun flush(): List<String> {
        val rest = buf.toString().trim()
        buf.clear()
        return if (rest.isEmpty()) emptyList() else listOf(rest).also { emitted++ }
    }

    fun reset() { buf.clear(); emitted = 0 }

    private fun findCut(): Int? {
        val s = buf
        for (i in s.indices) {
            val c = s[i]
            if (c == '.' || c == '!' || c == '?' || c == '\n') {
                val next = s.getOrNull(i + 1) ?: return null // need to see what follows
                if (c == '.' && next.isDigit()) continue // 3.5
                if (c == '.') {
                    val word = s.substring(0, i).takeLastWhile { it.isLetter() || it == '.' }.lowercase()
                    if (word in abbreviations || (word.length == 1 && word[0].isLetter())) continue
                }
                if (next.isWhitespace() || next == '"' || next == '\'' || next == ')') {
                    var j = i + 1
                    while (j < s.length && (s[j] == '"' || s[j] == '\'' || s[j] == ')')) j++
                    if (j >= 2) return j
                }
            }
        }
        // First chunk: start talking at a natural pause once there is enough to say.
        if (emitted == 0 && s.length > 34) {
            val comma = s.indexOf(", ", 24)
            if (comma in 24..140) return comma + 1
        }
        // Very long run-on: split at the last comma/semicolon so we never wait on a huge sentence.
        if (s.length > 220) {
            val k = maxOf(s.lastIndexOf(", ", 200), s.lastIndexOf("; ", 200))
            if (k > 40) return k + 1
        }
        return null
    }
}
