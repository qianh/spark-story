export function inventoryFixture(count = 1) {
  return {
    units: Array.from({ length: count }, (_, i) => ({
      id: `U${i + 1}`,
      arc: "成长",
      sourceAnchor: "雨中来信",
      description: "面对来信的选择",
      dramaticQuestion: "是否接受来信",
      steps: [
        { id: `S${i + 1}a`, description: "发现来信", kind: "setup" },
        { id: `S${i + 1}b`, description: "决定阅读", kind: "choice" },
      ],
    })),
  };
}
export function timingFixture(seconds = 90, count = 1) {
  return (
    "\n```production-json\n" +
    JSON.stringify({
      inventory: inventoryFixture(count),
      episodes: Array.from({ length: count }, (_, i) => ({
        id: `EP${String(i + 1).padStart(3, "0")}`,
        duration: seconds,
        dramaticQuestion: "是否接受来信",
        unitId: `U${i + 1}`,
        sourceStepIds: [`S${i + 1}a`, `S${i + 1}b`],
        majorChanges: [],
        newCharacters: [],
        newRules: [],
        beats: [
          {
            id: "B1",
            start: 0,
            end: seconds / 2,
            purpose: "hook",
            information: "来信",
            change: "好奇",
            exitState: "追问",
            sceneId: "scene1",
            performance: {
              dialogue: [{ speaker: "主角", text: "你好" }],
              actions:
                seconds < 10
                  ? []
                  : [
                      {
                        description: "慢慢拆开来信，翻看信纸上的印记",
                        seconds: seconds * 0.36,
                        overlapSpeech: false,
                      },
                    ],
              reaction: {
                description: "犹豫，抬头观察",
                seconds: seconds * 0.08,
              },
              transitionSeconds: 0,
            },
          },
          {
            id: "B2",
            start: seconds / 2,
            end: seconds,
            purpose: "closure",
            information: "真相",
            change: "决定",
            exitState: "行动",
            sceneId: "scene1",
            performance: {
              dialogue: [],
              actions: [
                {
                  description: "拿起信纸，转向门外",
                  seconds: seconds * 0.37,
                  overlapSpeech: false,
                },
              ],
              reaction: { description: "望向远处", seconds: seconds * 0.08 },
              transitionSeconds: 0,
            },
          },
        ],
      })),
    }) +
    "\n```"
  );
}
