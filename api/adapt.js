/* Kula Teach: live adapting.
   A Vercel serverless function, next to api/mentor.js. It uses the same key (ANTHROPIC_API_KEY).
   The app calls it for these jobs, chosen by "task":
     today     what Make my plan uses: fit the lesson to the class and follow up last time, in one go
     fit       only fit the lesson to this class and this room (kept for testing)
     followup  only follow up what happened last time (kept for testing)
     help      one fix for the step the teacher is on, from what they say is happening
     reflect   the mentor conversation after a lesson
     replan    turn what the teacher says happened into changes to the term plan
   The app sends the lesson content with every call (the knowledge base lives in the app), so this
   file holds the rules and the key, and nothing else. Every answer is checked here before it goes
   back. If a check fails, the app keeps what it had: nothing half-made reaches the teacher. */

const Anthropic = require("@anthropic-ai/sdk");

/* The same model and settings as mentor.js. If Help feels slow in class, try a faster model
   for that task only: change HELP_MODEL. */
const MODEL = "claude-opus-5";
const HELP_MODEL = MODEL;
const API = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const MOMENTS = ["Hook", "Quick check", "New learning", "Read and write", "Debate", "Exit check"];
const PHASES = ["starter", "main", "plenary"];

/* ---------- small helpers ---------- */
const s = (v, n) => String(v == null ? "" : v).slice(0, n);
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const noDash = (t) => String(t || "").replace(/\s*[—–]\s*/g, ", ").trim();

async function ask({ model, system, user, messages, schema, effort, maxTokens }) {
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: model || MODEL,
    max_tokens: maxTokens || 4000,
    ...API,
    output_config: { effort: effort || "low", format: { type: "json_schema", schema } },
    system,
    messages: messages || [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") return null;
  const text = response.content.find((b) => b.type === "text");
  return text ? JSON.parse(text.text) : null;
}

/* ---------- what every lesson must follow (from the project's design and content rules) ---------- */
const LESSON_RULES = [
  "You are Kula, the lesson engine inside Kula Teach, an app for South African teachers in their first years of teaching.",
  "You adapt a Grade 9 Social Sciences lesson that already exists. You do not write a new lesson from scratch.",
  "Facts: use only facts, dates, names and numbers that appear in the lesson content or the current steps you are given. Never add a fact of your own. If a step needs a fact you do not have, leave it out.",
  "Shape: return between 4 and 8 steps. The phases run in order: starter, then main, then plenary. Each step has a moment, which must be one of: Hook, Quick check, New learning, Read and write, Debate, Exit check. At least one step is Read and write, because learners read and write in every lesson. The last step is the Exit check, and it checks the lesson's core content, not the activity.",
  "Each step has a key question about the subject content, never about the activity. Keep the lesson's main key question unless the teacher asks for a change.",
  "Each step has exactly three instructions for the teacher. Each starts with a verb and is under 20 words. They say what the teacher does and what learners do. They are not a script.",
  "board: up to 6 short lines the teacher writes or shows. words: up to 5 short sentences the teacher can say, used only if they ask for them. fix: one sentence, what to do if the step is not working.",
  "The minutes add up to the lesson length. Do not mention a timer.",
  "The room decides the activity. With 45 or more learners and a chalkboard: pair talk in place, whole-class questioning, one source read aloud, writing in notebooks, hands or fingers for votes. No group work that needs moving desks, no printing, no devices. With devices or a smart board you may use them, but writing still goes in notebooks.",
  "Many learners work in a second language: keep sentences short, give key words on the board, and keep reading loads small.",
  "Mark each step changed true or false compared with the current steps.",
  "summary: one or two plain sentences to the teacher about what you changed overall.",
  "Writing: South African English, UK spelling, sentence case, short plain sentences, no dashes, no emoji. Say devices, not laptops.",
].join("\n");

const STEP_SCHEMA = {
  type: "object",
  properties: {
    moment: { type: "string", enum: MOMENTS },
    phase: { type: "string", enum: PHASES },
    title: { type: "string" },
    mins: { type: "integer" },
    q: { type: "string" },
    instr: { type: "array", items: { type: "string" } },
    board: { type: "array", items: { type: "string" } },
    words: { type: "array", items: { type: "string" } },
    fix: { type: "string" },
    changed: { type: "boolean" },
  },
  required: ["moment", "phase", "title", "mins", "q", "instr", "board", "words", "fix", "changed"],
  additionalProperties: false,
};
const LESSON_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" }, steps: { type: "array", items: STEP_SCHEMA } },
  required: ["summary", "steps"],
  additionalProperties: false,
};

/* The lesson, the class and the content, as plain text for the model. */
function lessonBrief(b) {
  const l = b.lesson || {}, c = b.cls || {}, u = b.unit || {};
  const lines = [];
  lines.push(`Class ${s(c.id, 10)}: Grade ${s(c.grade, 3)} ${s(c.subject, 40)}. ${s(c.learners, 4)} learners. Lessons of ${s(c.period, 4)} minutes.`);
  lines.push(`In the room: ${arr(c.kit, 10).map((k) => s(k, 60)).join(", ") || "not given"}.`);
  if (c.secondLang) lines.push(`Many learners are taught in a language that is not their home language.`);
  if (arr(c.notes, 6).length) lines.push(`What the teacher has noted about this class: ${arr(c.notes, 6).map((x) => s(x, 200)).join(" ")}`);
  lines.push("");
  lines.push(`The lesson: "${s(l.title, 160)}". Main key question: ${s(l.kq, 200)}`);
  if (u.point) lines.push(`What it is really about: ${s(u.point, 900)}`);
  if (arr(u.core, 6).length) lines.push(`Learners should leave able to say: ${arr(u.core, 6).map((x) => s(x, 300)).join(" | ")}`);
  if (u.wrong) lines.push(`What learners often get wrong: ${s(u.wrong, 1200)}`);
  if (arr(u.terms, 12).length) lines.push(`Key words: ${arr(u.terms, 12).map((t) => `${s(t[0], 40)}: ${s(t[1], 160)}`).join("; ")}`);
  if (u.story) lines.push(`Background for the teacher (facts you may use):\n${s(u.story, 9000)}`);
  lines.push("");
  lines.push("The current steps:");
  arr(l.steps, 10).forEach((st, i) => {
    lines.push(`${i + 1}. ${s(st.moment, 30)} (${s(st.phase, 10)}, ${s(st.mins, 3)} min): ${s(st.title, 120)}. Key question: ${s(st.q, 200)}`);
    arr(st.instr, 4).forEach((x) => lines.push(`   - ${s(x, 200)}`));
    if (arr(st.board, 8).length) lines.push(`   Board: ${arr(st.board, 8).map((x) => s(x, 160)).join(" / ")}`);
    if (arr(st.words, 6).length) lines.push(`   Words: ${arr(st.words, 6).map((x) => s(x, 300)).join(" ")}`);
  });
  return lines.join("\n");
}

/* Check an adapted lesson. Returns clean steps, or null if it cannot be used. */
function checkLesson(out, period) {
  if (!out || !Array.isArray(out.steps)) return null;
  let steps = out.steps.slice(0, 8).map((x) => ({
    moment: MOMENTS.includes(x.moment) ? x.moment : null,
    phase: PHASES.includes(x.phase) ? x.phase : null,
    title: noDash(s(x.title, 90)),
    mins: Math.max(1, Math.round(Number(x.mins) || 0)),
    q: noDash(s(x.q, 220)),
    instr: arr(x.instr, 3).map((t) => noDash(s(t, 220))).filter(Boolean),
    board: arr(x.board, 6).map((t) => noDash(s(t, 160))).filter(Boolean),
    words: arr(x.words, 5).map((t) => noDash(s(t, 400))).filter(Boolean),
    fix: noDash(s(x.fix, 240)),
    changed: !!x.changed,
  }));
  if (steps.length < 4) return null;
  if (steps.some((x) => !x.moment || !x.phase || !x.title || !x.q || x.instr.length !== 3)) return null;
  const order = { starter: 0, main: 1, plenary: 2 };
  for (let i = 1; i < steps.length; i++) if (order[steps[i].phase] < order[steps[i - 1].phase]) return null;
  if (steps[steps.length - 1].moment !== "Exit check") return null;
  if (!steps.some((x) => x.moment === "Read and write")) return null;
  /* minutes: make them add up to the period, by adjusting the longest step */
  const want = Number(period) || 40, total = steps.reduce((a, x) => a + x.mins, 0);
  if (total !== want) {
    const scale = want / total;
    steps.forEach((x) => { x.mins = Math.max(2, Math.round(x.mins * scale)); });
    const diff = want - steps.reduce((a, x) => a + x.mins, 0);
    const big = steps.reduce((m, x) => (x.mins > m.mins ? x : m), steps[0]);
    big.mins = Math.max(2, big.mins + diff);
  }
  return { summary: noDash(s(out.summary, 400)), steps };
}

/* ---------- the four jobs ---------- */

async function fit(b) {
  const note = s(b.note, 600);
  const out = await ask({
    effort: "medium",
    system: LESSON_RULES + "\n\nYour job now: fit this lesson to this class and this room. Change only what the room, the class size, the period length or the teacher's note makes necessary. Keep what already works. If the steps already fit, say so in the summary and mark nothing as changed.",
    user: lessonBrief(b) + (note ? `\n\nThe teacher's note about today: ${note}` : ""),
    schema: LESSON_SCHEMA,
  });
  return checkLesson(out, (b.cls || {}).period);
}

async function followup(b) {
  const last = b.last || {};
  const lines = ["What happened last time with this class:"];
  if (last.landed) lines.push(`Where they finished: ${s(last.landed, 300)}`);
  if (last.hard) lines.push(`What the teacher found hard: ${s(last.hard, 300)}`);
  if (last.working) lines.push(`What the teacher is working on: ${s(last.working, 120)}`);
  if (last.trying) lines.push(`What the teacher chose to try this lesson: ${s(last.trying, 200)}`);
  if (arr(last.unfinished, 6).length) lines.push(`Steps not reached last time: ${arr(last.unfinished, 6).map((x) => s(x, 120)).join("; ")}`);
  if (arr(last.weak, 5).length) lines.push(`Points only some learners got: ${arr(last.weak, 5).map((x) => s(x, 200)).join("; ")}`);
  if (last.exit) lines.push(`How many learners got last lesson's exit check right: ${s(last.exit, 20)}`);
  if (last.prevTitle) lines.push(`Last lesson's title: ${s(last.prevTitle, 160)}`);
  const out = await ask({
    effort: "medium",
    system: LESSON_RULES + "\n\nYour job now: change this lesson so it follows up what happened last time. Use one or two changes, not more. Typical changes: a quick check at the start on what only some learners got last time; a short catch-up step for what was not reached, if it matters for today; building what the teacher chose to try, or what they are working on, into one step. Keep today's content and key question. Do not make the lesson longer: take time from somewhere else.",
    user: lessonBrief(b) + "\n\n" + lines.join("\n"),
    schema: LESSON_SCHEMA,
  });
  return checkLesson(out, (b.cls || {}).period);
}

/* What "Make my plan" calls: fit the lesson to the class and follow up last time, in one go. */
async function today(b) {
  const last = b.last || {}, note = s(b.note, 600), lines = [];
  if (last.landed) lines.push(`Where they finished: ${s(last.landed, 300)}`);
  if (last.hard) lines.push(`What the teacher found hard: ${s(last.hard, 300)}`);
  if (last.working) lines.push(`What the teacher is working on: ${s(last.working, 120)}`);
  if (last.trying) lines.push(`What the teacher chose to try this lesson: ${s(last.trying, 200)}`);
  if (last.exit) lines.push(`How many learners got last lesson's exit check right: ${s(last.exit, 20)}`);
  const out = await ask({
    effort: "medium",
    system: LESSON_RULES + "\n\nYour job now has two parts. First, fit this lesson to this class and this room: change only what the room, the class size, the period length or the teacher's note about today makes necessary. Second, if you are told what happened last time, follow it up with one or two changes, not more: for example a quick check at the start on what only some learners got, or building what the teacher is working on into one step. Keep today's content and key question, and keep what already works. Do not make the lesson longer. If nothing needs to change, mark nothing as changed and say so. summary is one sentence, under 25 words.",
    user: lessonBrief(b) + (lines.length ? "\n\nWhat happened last time with this class:\n" + lines.join("\n") : "") + (note ? `\n\nThe teacher's note about today: ${note}` : ""),
    schema: LESSON_SCHEMA,
  });
  return checkLesson(out, (b.cls || {}).period);
}

async function help(b) {
  const st = b.step || {}, c = b.cls || {};
  const out = await ask({
    model: HELP_MODEL,
    effort: "low",
    maxTokens: 700,
    system: [
      "You are Kula, inside Kula Teach. A South African teacher is in the middle of a lesson and has asked for help. They have seconds, not minutes.",
      "Give one way to rescue the step they are on, based on what they say is happening. Not a menu.",
      "fix: one sentence, under 15 words, what to do right now. moves: three short actions in order, each starting with a verb, each under 12 words. A teacher reads this at a glance, standing up: no lists inside a move, no second sentence.",
      "If they are unsure of the content, give them the one or two facts they need from the step itself, in the moves. Never add a fact that is not in the step.",
      "Fit the room: with a large class and a chalkboard, no group moves, no devices, no printing. Keep the step's content. Never shame the teacher or the learners.",
      "If what they describe sounds like a child at risk, violence, or a serious safeguarding matter, the fix says to get another adult or the school's safety person now.",
      "South African English, UK spelling, short plain sentences, no dashes, no emoji.",
    ].join("\n"),
    user:
      `Class: ${s(c.learners, 4)} learners, Grade ${s(c.grade, 3)} ${s(c.subject, 40)}. In the room: ${arr(c.kit, 10).map((k) => s(k, 60)).join(", ")}.\n` +
      `Lesson: "${s(b.title, 160)}".\n` +
      `The step: ${s(st.moment, 30)}, "${s(st.title, 120)}". Key question: ${s(st.q, 200)}\n` +
      `Its instructions: ${arr(st.instr, 3).map((x) => s(x, 200)).join(" / ")}\n` +
      `What is happening, in the teacher's words: ${s(b.text, 600)}`,
    schema: {
      type: "object",
      properties: { fix: { type: "string" }, moves: { type: "array", items: { type: "string" } } },
      required: ["fix", "moves"],
      additionalProperties: false,
    },
  });
  if (!out || !out.fix) return null;
  const moves = arr(out.moves, 3).map((t) => noDash(s(t, 120))).filter(Boolean);
  if (!moves.length) return null;
  return { fix: noDash(s(out.fix, 160)), moves };
}

/* The mentor conversation after a lesson. The app sends the whole conversation each turn; nothing is
   kept here. The mentor talks like a person: it listens, asks one thing at a time, and ends by
   agreeing one thing to try. Only in its last turn does it fill in the outcomes the app saves. */
async function reflect(b) {
  const x = b.ctx || {}, c = x.cls || {};
  const options = arr(x.recapOptions, 12).map((o) => s(o, 120)).filter(Boolean);
  const turns = arr(b.messages, 24).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
  const said = turns.filter((m) => m.role === "user").length;
  if (!turns.length || turns[0].role !== "user") turns.unshift({ role: "user", content: "(The teacher has just saved their ratings. Begin the conversation.)" });
  const facts = [];
  facts.push(x.name ? `The teacher's name is ${s(x.name, 40)}. Use it once at most.` : "You do not know the teacher's name.");
  facts.push(`Class ${s(c.id, 10)}: Grade ${s(c.grade, 3)} ${s(c.subject, 40)}, ${s(c.learners, 4)} learners, lessons of ${s(c.period, 4)} minutes. In the room: ${arr(c.kit, 10).map((k) => s(k, 60)).join(", ") || "not given"}.`);
  facts.push(`The lesson they have just taught: "${s(x.title, 160)}". Key question: ${s(x.kq, 200)}`);
  if (arr(x.steps, 10).length) facts.push(`Its steps: ${arr(x.steps, 10).map((y) => s(y, 100)).join("; ")}.`);
  if (x.point) facts.push(`What the lesson is about (the only history you may use): ${s(x.point, 900)}`);
  if (arr(x.objectives, 5).length) facts.push("How many learners could do each objective, as the teacher judged it:\n" + arr(x.objectives, 5).map((o) => `- ${s(o.text, 200)}: ${s(o.level, 20)}`).join("\n"));
  else facts.push("The teacher did not get to check what learners could do.");
  if (arr(x.ratings, 6).length) facts.push("How the teacher rated themselves, out of 5:\n" + arr(x.ratings, 6).map((r) => `- ${s(r.text, 160)}: ${s(r.value, 2)}`).join("\n"));
  if (x.wish) facts.push(`One thing they said they want to change next time: ${s(x.wish, 300)}`);
  if (x.signals) facts.push(`What happened in the lesson: ${s(x.signals, 500)}`);
  if (x.cut) facts.push(`The lesson stopped early. Their reason: ${s(x.cut, 80)}`);
  if (x.working) facts.push(`What they were working on in this lesson: ${s(x.working, 120)}`);
  if (x.trying) facts.push(`Last time they said they would try: "${s(x.trying, 200)}". Ask how it went, once, where it fits.`);
  const moments = arr(x.moments, 6).map((m) => s(m, 140)).filter(Boolean);
  if (moments.length) facts.push(`During the lesson the teacher tapped "Remember this" to save a moment for this conversation, at: ${moments.join("; ")}.`);
  else facts.push("The teacher did not save any moment during the lesson.");
  if (options.length) facts.push("Things the next lesson could start with a short recap of. Use these exact words in recap:\n" + options.map((o) => `- ${o}`).join("\n"));
  const out = await ask({
    effort: "medium",
    maxTokens: 900,
    system: [
      "You are the mentor in Kula Teach, an app for South African teachers in their first years. You are an experienced teacher who has mentored many new teachers. For most of the teachers you talk to, you are the only mentor they have. They have just finished a lesson and given a few quick ratings. Now the two of you talk, briefly, the way a mentor would in the corridor afterwards.",
      "",
      "How a mentor talks",
      "You are a person in a conversation, not a form. Respond to what the teacher actually said, in their words. Pick up the specific detail and stay with it. Never give a stock reply that would fit any answer.",
      "Ask before you tell. One question a turn, open, and about their teaching: what they did, what they noticed, a decision they made. Never give a menu of answers to pick from.",
      "Do not read the ratings back to them, and do not quote the objectives. You know these things the way a mentor who watched the lesson would. Speak about the lesson, the learners and the history.",
      "Be honest and warm. Say plainly what you think once they have had a go. Do not flatter, do not cheer, do not open with thanks. Supportive does not mean soft.",
      "One thing at a time. A new teacher who hears three fixes hears three criticisms.",
      "If they are unsure, make it smaller: one moment, one learner, one minute of the lesson.",
      "If they tell you it was a hard lesson, take that seriously first. Advice can wait, or not come at all.",
      "Be concrete. Anything you suggest must be doable in their next lesson, in their room, with their class size. No group moves or devices in a chalk-only class of 50.",
      "Use only the history you are given. If they ask about content you do not have, say you would rather they check it in the lesson's content page than guess.",
      "If they describe a child at risk or a serious incident, say so plainly and tell them to take it to the person responsible for safety at their school today.",
      "",
      "The shape of the conversation",
      moments.length
        ? "The teacher saved a moment during the lesson, so start there. Your first turn: ask what happened at that moment and why they wanted to remember it. One or two sentences. Do not open with the ratings."
        : "The teacher saved no moment, so keep it open and about their practice, not about what learners scored. Your first turn is one short, open question: what went well in that lesson? Nothing else. Do not summarise the lesson, do not mention how many learners got what, and do not steer them to a topic.",
      "Then, one turn at a time: follow what they say went well and say what you make of it, briefly. Next ask what they would improve or do differently. Let them choose the thing; do not choose it for them from the ratings. Bring in what learners could or could not do only if it bears on what they raise, or if they ask what you noticed.",
      "Once they have named something to improve, offer one or two ideas for the next lesson that fit their room and class, in plain sentences, and ask which they would try, or whether they have their own.",
      "Middle turns are two or three short sentences. Offer your own view only when they have given theirs.",
      `The teacher has replied ${said} time${said === 1 ? "" : "s"} so far. Close after their third or fourth reply, sooner if they have clearly chosen something or want to stop. ${said >= 4 ? "This turn must be the closing turn." : ""}`,
      "The closing turn: no question. Say back, in a sentence, what they worked out. Name the one thing they will try next lesson, in their words if they chose it. If a short recap at the start of the next lesson would help, say what it will cover. Then stop.",
      "",
      "What you fill in",
      "reply: what you say. closing: true only in the closing turn.",
      "Only in the closing turn: trying is the one thing to try next lesson, as a short phrase starting with a verb, under 10 words, or empty if they chose to leave it. recap is up to two items from the recap list, copied exactly, or empty. tried says how the thing they tried last time went: helped, not yet, not tried, or none if it did not come up.",
      "In every other turn: trying is empty, recap is empty, tried is none.",
      "",
      "Writing: South African English, UK spelling, short plain sentences, no dashes, no emoji, no bullet points, no bold.",
      "",
      "What you know",
      facts.join("\n"),
    ].join("\n"),
    user: null,
    messages: turns,
    schema: {
      type: "object",
      properties: {
        reply: { type: "string" }, closing: { type: "boolean" }, trying: { type: "string" },
        recap: { type: "array", items: { type: "string" } },
        tried: { type: "string", enum: ["helped", "not yet", "not tried", "none"] },
      },
      required: ["reply", "closing", "trying", "recap", "tried"],
      additionalProperties: false,
    },
  });
  if (!out || !out.reply) return null;
  const closing = !!out.closing || said >= 5;
  return {
    reply: noDash(s(out.reply, 900)), closing,
    trying: closing ? noDash(s(out.trying, 90)).replace(/\.$/, "") : "",
    recap: closing ? arr(out.recap, 4).filter((r) => options.includes(r)).slice(0, 2) : [],
    tried: closing && ["helped", "not yet", "not tried"].includes(out.tried) ? out.tried : "none",
  };
}

/* The term plan. The model proposes actions; this function checks each against the plan and the
   rules, and drops any that break them. Assessments are never touched. */
async function replan(b) {
  const plan = b.plan || {};
  const items = arr(plan.items, 60).map((i) => ({
    id: s(i.id, 20), title: s(i.title, 160), type: i.type === "assessment" ? "assessment" : "lesson",
    planned: !!i.planned, week: Number(i.week) || null, optional: !!i.optional,
  }));
  const byId = new Map(items.map((i) => [i.id, i]));
  const nowWeek = Number(plan.nowWeek) || 1, lastWeek = Number(plan.weeks) || 11, perWeek = Number(plan.perWeek) || 3;
  const out = await ask({
    effort: "medium",
    system: [
      "You are Kula, inside Kula Teach. You help a South African teacher keep their term plan workable when something happens: lost lessons, a lesson that ran over, a class that needs more time on a topic.",
      "Turn what the teacher says into actions on their plan. Use the fewest actions that deal with what they said.",
      "Actions you may use:",
      "lose: lessons that will not happen. Give week and count.",
      "merge: teach two planned lessons as one. Give id, with (the second lesson's id) and a short title for the joined lesson. Only merge lessons that sit next to each other and belong together.",
      "drop: remove a planned lesson. Only a revision, catch-up or optional lesson may be dropped. Never drop a CAPS content lesson; merge it instead.",
      "move: move a planned lesson to just after another planned item. Give id and after.",
      "add: add a catch-up lesson after a planned item. Give after and title.",
      "Rules: never change, move or drop an assessment. Never touch a lesson that has been taught (planned is false). Use only ids from the plan. Each action has a why: one plain sentence to the teacher.",
      "summary: one or two plain sentences to the teacher. keep: one sentence on what stays the same, usually the assessments.",
      "If what they said needs no change, return no actions and say why in the summary.",
      "South African English, UK spelling, short plain sentences, no dashes.",
    ].join("\n"),
    user:
      `Class ${s(plan.cls, 10)}. ${perWeek} lessons a week. This is week ${nowWeek} of ${lastWeek}.\n` +
      `Lessons already lost: ${s(plan.lost, 200) || "none"}.\n` +
      `Lessons that do not fit at the moment: ${s(plan.issues, 400) || "none"}.\n\n` +
      "The plan, in order:\n" +
      items.map((i) => `${i.id} | ${i.type}${i.optional ? " (optional)" : ""} | ${i.planned ? "planned" : "taught"}${i.week ? ` | week ${i.week}` : ""} | ${i.title}`).join("\n") +
      `\n\nWhat the teacher says: ${s(b.text, 800)}`,
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        keep: { type: "string" },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["lose", "merge", "drop", "move", "add"] },
              week: { type: "integer" }, count: { type: "integer" },
              id: { type: "string" }, with: { type: "string" }, after: { type: "string" },
              title: { type: "string" }, why: { type: "string" },
            },
            required: ["type", "why"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "keep", "actions"],
      additionalProperties: false,
    },
  });
  if (!out) return null;
  const planned = (id) => { const i = byId.get(id); return i && i.planned && i.type === "lesson" ? i : null; };
  const used = new Set(), actions = [];
  for (const a of arr(out.actions, 8)) {
    const why = noDash(s(a.why, 240));
    if (a.type === "lose") {
      const week = Number(a.week), count = Math.max(1, Math.min(perWeek, Number(a.count) || 1));
      if (week >= nowWeek && week <= lastWeek) actions.push({ type: "lose", week, count, why });
    } else if (a.type === "merge") {
      const x = planned(a.id), y = planned(a.with);
      if (x && y && x !== y && !used.has(x.id) && !used.has(y.id)) { used.add(x.id); used.add(y.id); actions.push({ type: "merge", id: x.id, with: y.id, title: noDash(s(a.title, 90)) || `${x.title} and ${y.title}`, why }); }
    } else if (a.type === "drop") {
      const x = planned(a.id);
      if (x && !used.has(x.id) && (x.optional || /revision|catch-up|catch up/i.test(x.title) || /^N\d/.test(x.id))) { used.add(x.id); actions.push({ type: "drop", id: x.id, why }); }
    } else if (a.type === "move") {
      const x = planned(a.id), after = byId.get(s(a.after, 20));
      if (x && after && after.planned && after.id !== x.id && !used.has(x.id)) { used.add(x.id); actions.push({ type: "move", id: x.id, after: after.id, why }); }
    } else if (a.type === "add") {
      const after = byId.get(s(a.after, 20)), title = noDash(s(a.title, 90));
      if (after && after.planned && title) actions.push({ type: "add", after: after.id, title, why });
    }
  }
  return { summary: noDash(s(out.summary, 400)), keep: noDash(s(out.keep, 200)), actions };
}

const TASKS = { today, fit, followup, help, replan, reflect };

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "no key configured" });
  const body = req.body || {}, job = TASKS[body.task];
  if (!job) return res.status(400).json({ error: "unknown task" });
  try {
    const out = await job(body);
    if (!out) return res.status(422).json({ error: "could not use the answer" });
    return res.status(200).json(out);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "rate limited" });
    if (err instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "bad key" });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ error: `api ${err.status}` });
    return res.status(502).json({ error: "adapt unavailable" });
  }
};
