// Prompt construction for live answers, chat, screenshots, notes and mock interviews.
const { LANG_NAMES } = require('./languages');
const { selectContext } = require('./rag');

function clip(text, max) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max) + '\n…[truncated]';
}

function langName(code) {
  return code && code !== 'auto' ? LANG_NAMES[code] || code : null;
}

// Splits the context budget between instructions, resume and documents. Documents are searched with the
// current question (query) so the most relevant passages are sent rather than just the first pages.
function contextBlock(session, settings, budget, query = '') {
  const parts = [];
  const useResume = session.mode !== 'call' && settings.resume;
  let remaining = budget;
  if (session.instructions) {
    const t = clip(session.instructions, Math.floor(remaining * 0.4));
    parts.push(`## Instructions from the user\n${t}`);
    remaining -= t.length;
  }
  if (useResume) {
    const t = clip(settings.resume, Math.floor(remaining * 0.5));
    parts.push(`## The user's resume / CV\n${t}`);
    remaining -= t.length;
  }
  const docs = (session.documents || []).filter((d) => d.text);
  if (docs.length && remaining > 500) {
    parts.push('## Reference documents\n' + selectContext(docs, query, remaining));
  }
  return parts.join('\n\n');
}

function systemPrompt(session, settings, { withContext = true, query = '' } = {}) {
  const lang = langName(session.language);
  const kind = session.mode === 'call' ? 'a live call (meeting, sales or client conversation)' : 'a live job interview';
  return [
    `You are a real-time assistant helping the user during ${kind}. The transcript labels the other party as "Them" and the user as "Me".`,
    'Write what the user should say next, in first person, as natural spoken language they can read aloud at a glance.',
    'Format: start with a direct 1-2 sentence answer in **bold**, then 2-5 short bullet points with supporting detail, examples or numbers. No preamble, no "As an AI".',
    'For coding or technical questions: give the approach in plain words, then the code in a fenced block, then time/space complexity.',
    'Ground answers in the resume, instructions and documents when relevant; never invent employers, dates or credentials that are not given.',
    lang ? `Always respond in ${lang}.` : 'Respond in the language the conversation is in.',
    withContext ? contextBlock(session, settings, settings.contextChars || 20000, query) : '',
  ].filter(Boolean).join('\n\n');
}

// What the documents search should match: the question plus the last few transcript lines.
function queryFrom(lines, extra = '') {
  return [extra, ...(lines || []).slice(-4).map((l) => l.text)].join(' ');
}

function transcriptText(lines, maxChars = 6000) {
  const text = (lines || []).map((l) => `${l.who}: ${l.text}`).join('\n');
  return text.length > maxChars ? '…' + text.slice(-maxChars) : text;
}

function answerMessages(session, settings, lines, question) {
  const t = transcriptText(lines);
  const ask = question
    ? `Answer this question: "${question}"`
    : 'Respond to the most recent question or request from "Them". If the last thing said was not a question, suggest what the user could say next.';
  return [
    { role: 'system', content: systemPrompt(session, settings, { query: queryFrom(lines, question) }) },
    { role: 'user', content: `Live transcript (most recent last):\n${t || '(nothing transcribed yet)'}\n\n${ask}` },
  ];
}

function chatMessages(session, settings, lines, history, message) {
  return [
    { role: 'system', content: systemPrompt(session, settings, { query: queryFrom(lines, message) }) + '\n\nThe user may also message you privately during the call; reply to them directly and briefly.' },
    { role: 'user', content: `Live transcript so far:\n${transcriptText(lines) || '(nothing yet)'}` },
    ...history.slice(-8),
    { role: 'user', content: message },
  ];
}

function screenshotMessages(session, settings, lines, imageDataUrl) {
  return [
    { role: 'system', content: systemPrompt(session, settings, { withContext: false }) },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `Recent transcript:\n${transcriptText(lines, 2500) || '(none)'}\n\n` +
            'Here is a screenshot of the user\'s screen. If it shows a coding, math or technical problem, solve it completely: restate the problem in one line, explain the approach, give full working code in the language shown (or Python), then complexity. ' +
            'Otherwise, explain what on the screen is relevant and what the user should say or do.',
        },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

function notesMessages(session, lines) {
  return [
    {
      role: 'system',
      content: 'You write concise post-call notes in Markdown with these sections: ## Summary (3-5 sentences), ## Key points, ## Action items (with owner if known), ## Decisions, ## Questions asked (each with a one-line note on how it was answered and how the answer could be improved). Skip a section if empty.',
    },
    { role: 'user', content: `Session: ${session.title || 'Untitled'} (${session.mode})\n\nTranscript:\n${transcriptText(lines, 40000) || '(empty)'}` },
  ];
}

function mockMessages(session, settings, history, candidateAnswer) {
  const lang = langName(session.language);
  const sys = [
    'You are a professional, friendly but rigorous job interviewer running a realistic mock interview, speaking out loud.',
    'Ask exactly one question at a time. Mix behavioural, role-specific and technical questions appropriate to the role. Keep each turn under 70 words since it will be spoken aloud.',
    'Reply in this exact format:\nFEEDBACK: <one or two sentences on the previous answer, or "none" for the first turn>\nQUESTION: <your next question>',
    lang ? `Speak in ${lang}.` : '',
    contextBlock(session, settings, Math.min(settings.contextChars || 10000, 6000)),
  ].filter(Boolean).join('\n\n');
  const msgs = [{ role: 'system', content: sys }, ...history];
  msgs.push({ role: 'user', content: candidateAnswer ? `Candidate's answer: ${candidateAnswer}` : 'Start the interview with a short greeting and the first question.' });
  return msgs;
}

function tailorMessages(resume, jobDescription) {
  return [
    {
      role: 'system',
      content:
        'You are an expert resume writer. Rewrite the candidate\'s resume for the target job. Keep every fact true: do not invent employers, titles, dates, degrees, numbers or skills that are not in the original. ' +
        'Reorder and rephrase to lead with the most relevant experience, mirror the job\'s keywords where they truthfully apply, and quantify impact only with numbers already present. ' +
        'Output clean Markdown: name and contact line, a 2-3 line summary, Skills, Experience (bullets starting with strong verbs), Projects (if any), Education. After the resume, add a line "---" and then "## Gaps to prepare for" listing 3-6 job requirements the resume does not show, each with a one-line tip on how to address it in the interview.',
    },
    { role: 'user', content: `## Target job description\n${jobDescription}\n\n## Current resume\n${resume}` },
  ];
}

function questionPrepMessages(session, settings, question) {
  return [
    { role: 'system', content: systemPrompt(session, settings, { query: question }) },
    { role: 'user', content: `Prepare a strong answer the user can practise for this interview question: "${question}". Use the answer format above, then add a short "Why this works" line.` },
  ];
}

module.exports = { answerMessages, chatMessages, screenshotMessages, notesMessages, mockMessages, tailorMessages, questionPrepMessages };
