// List the model ids your keys can actually use. `npm run models`
const gk = process.env.GEMINI_API_KEY;
if (gk) {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': gk } });
  if (!res.ok) console.log(`Gemini: ${res.status} ${(await res.text()).slice(0, 200)}`);
  else {
    const j = await res.json();
    const models = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'));
    console.log(`\nGemini models usable with this key (${models.length}):`);
    for (const m of models.sort((a, b) => a.name.localeCompare(b.name))) {
      const id = m.name.replace(/^models\//, '');
      console.log(`  ${id.padEnd(44)} in ${String(m.inputTokenLimit || '').padStart(8)}  out ${String(m.outputTokenLimit || '').padStart(6)}  ${m.displayName || ''}`);
    }
    console.log('\nUse the id exactly as printed, e.g.  GEMINI_MODEL=gemini-3.8-flash  or  --model=<id>');
  }
} else console.log('GEMINI_API_KEY not set — skipping Gemini.');
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic(); const ids = [];
  for await (const m of client.models.list()) ids.push(m.id);
  console.log(`\nAnthropic models (${ids.length}): ${ids.join(', ')}`);
} else console.log('ANTHROPIC_API_KEY not set — skipping Anthropic.');
