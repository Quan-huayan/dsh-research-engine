// 验收专用：headless 会话里的「脚本化用户」。
//
// headless 没有交互界面，ctx.userQuestions 没有 provider → ask_user_question 会失败。
// 为了在验收里真正跑通「用户权威」链路（ask_user_question 产生 tool/call + tool/result →
// convention_declare / note_adjudicate 回查会话），本文件注册一个 provider，
// 按环境变量 RESEARCH_TEST_ANSWER_JSON 返回预设答复。
//
// 它不是交付物：只在 --patch overlay 里挂载，不写进 preset。
//
// RESEARCH_TEST_ANSWER_JSON 形如：
//   [{"match":"参数差","selected":["必须 <10%"],"custom":"以参数差 <10% 为准"}]
// match = 问题文本的子串；缺省 match 的条目作为兜底。

export const name = 'test-answer-provider';
export const inject = ['userQuestions'];

function loadScript() {
  const raw = process.env.RESEARCH_TEST_ANSWER_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function apply(ctx) {
  const script = loadScript();
  const dispose = ctx.userQuestions.registerProvider({
    async ask(request) {
      const answers = [];
      for (const q of request.questions ?? []) {
        const text = String(q.question ?? '');
        const hit = script.find((s) => typeof s?.match === 'string' && text.includes(s.match)) ?? script.find((s) => s?.match === undefined);
        answers.push({
          id: q.id,
          selected: Array.isArray(hit?.selected) ? hit.selected.map(String) : ['（验收脚本未配置答复）'],
          ...(typeof hit?.custom === 'string' ? { custom: hit.custom } : {}),
        });
      }
      return { answers };
    },
  });
  ctx.effect(() => () => dispose());
}
