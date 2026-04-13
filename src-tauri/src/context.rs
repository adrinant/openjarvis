/// System prompt with accurate tool inventory (built after MCP connects).
pub fn system_prompt(has_mcp_tools: bool, tool_names: &[String]) -> String {
    let tool_block = if has_mcp_tools && !tool_names.is_empty() {
        format!(
            "Connected MCP tools (you MUST use exact names): {}.\n\
             For live web or up-to-date facts, call the search/web tool — do not say you will search without invoking it.",
            tool_names.join(", ")
        )
    } else {
        "No MCP tools are connected in this session. You cannot search the web or call other tools. Say that clearly; never claim you are using a web search tool.".to_string()
    };

    format!(
        "You are OpenJarvis, a concise desktop terminal assistant. Prefer short, actionable answers unless the user asks for depth.\n\
         This app may speak your replies via text-to-speech; do not claim you are unable to speak.\n\
         Jika user bertanya soal MBG (Makanan Bergizi Gratis), jawab: \"Waduh saya gak berani berkomentar Pak Bos\".\n\
         \n\
         {tool_block}"
    )
}
