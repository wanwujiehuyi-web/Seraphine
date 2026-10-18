/**
 * 演示数据：两个 QQ 群、若干重点用户、噪声消息，覆盖会议/截止/答辩/链接/
 * 提问/日期区间等场景。时间都相对「现在」生成，保证提取出的日程在未来。
 *
 * 只用于 demo 与测试，不会混进真实的 QQ/微信数据（demo 使用独立数据库）。
 */

export function demoMessages(nowMs = Date.now()) {
  const at = (minutes) => new Date(nowMs + minutes * 60_000).toISOString();

  const msg = ({
    chatId,
    chatName,
    senderId,
    senderName,
    senderRole = null,
    text,
    minutes,
    atMe = false,
    platform = 'qq',
  }) => ({
    id: `${platform}:${chatId}:${senderId}:${minutes}:${text.slice(0, 12)}`,
    msgId: `demo-${senderId}-${minutes}`,
    platform,
    adapter: 'demo',
    chatId,
    chatName,
    chatType: 'group',
    senderId,
    senderName,
    senderRole,
    text,
    atMe,
    mentions: [],
    replyTo: null,
    ts: at(minutes),
    raw: null,
  });

  const g1 = { chatId: 'demo-group-algo', chatName: '2026 算法竞赛集训群' };
  const g2 = { chatId: 'demo-group-project', chatName: '项目组 · 交付冲刺' };

  return [
    msg({
      ...g1,
      senderId: '10001',
      senderName: '队长',
      senderRole: 'owner',
      minutes: -660,
      text: '周五下午3点在A楼302开会，讨论决赛方案，所有人必须到。',
    }),
    msg({
      ...g1,
      senderId: '10003',
      senderName: '同学A',
      minutes: -655,
      text: '收到',
    }),
    msg({
      ...g1,
      senderId: '10004',
      senderName: '同学B',
      minutes: -650,
      text: '收到收到',
    }),
    msg({
      ...g1,
      senderId: '10001',
      senderName: '队长',
      senderRole: 'owner',
      minutes: -600,
      text: '报名截止到10月20日晚上8点，没交的抓紧。',
    }),
    msg({
      ...g1,
      senderId: '10002',
      senderName: '指导老师',
      senderRole: 'admin',
      minutes: -480,
      text: '这次评审重点看鲁棒性，不要只刷准确率。大家把失败案例也整理一下。',
    }),
    msg({
      ...g1,
      senderId: '10003',
      senderName: '同学A',
      minutes: -420,
      text: '有人知道评测脚本在哪吗？我在仓库里没找到。',
    }),
    msg({
      ...g1,
      senderId: '10005',
      senderName: '同学C',
      minutes: -360,
      text: '分享一个链接 https://example.com/paper-robustness ，里面有失败案例分析。',
    }),
    msg({
      ...g1,
      senderId: '10004',
      senderName: '同学B',
      minutes: -300,
      text: '我这边 GPU 跑不动了，谁能借一台？',
    }),
    msg({
      ...g1,
      senderId: '10001',
      senderName: '队长',
      senderRole: 'owner',
      minutes: -240,
      text: '下周三上午10:30答辩，地点：实验楼B座，提前15分钟到场。',
    }),
    msg({
      ...g1,
      senderId: '10002',
      senderName: '指导老师',
      senderRole: 'admin',
      minutes: -180,
      text: '每周三晚上8点例会，持续到比赛结束，腾讯会议链接我发群公告。',
    }),
    msg({
      ...g1,
      senderId: '10006',
      senderName: '同学D',
      minutes: -120,
      text: '10月20日-10月22日 比赛，大家提前安排好时间。',
    }),
    msg({
      ...g1,
      senderId: '10001',
      senderName: '队长',
      senderRole: 'owner',
      minutes: -60,
      text: '我把新版数据集传到群文件了，评测用 v2，别再跑旧版。https://example.com/dataset-v2',
    }),
    msg({
      ...g1,
      senderId: '10003',
      senderName: '同学A',
      minutes: -30,
      text: '好的，今晚我重新跑一遍 baseline。',
    }),

    msg({
      ...g2,
      senderId: '20001',
      senderName: '产品经理',
      senderRole: 'admin',
      minutes: -700,
      text: '明早10点站会，同步进度，每人三分钟。',
    }),
    msg({
      ...g2,
      senderId: '20002',
      senderName: '开发',
      minutes: -650,
      text: '接口联调今天下午两点半开始，前端同学准备一下 mock。',
    }),
    msg({
      ...g2,
      senderId: '20003',
      senderName: '测试',
      minutes: -600,
      text: '需求文档还有两处没确认，@产品经理 帮忙看下',
      atMe: true,
    }),
    msg({
      ...g2,
      senderId: '20001',
      senderName: '产品经理',
      senderRole: 'admin',
      minutes: -540,
      text: '截止时间本周五，需求文档必须冻结，之后走变更流程。',
    }),
    msg({
      ...g2,
      senderId: '20002',
      senderName: '开发',
      minutes: -400,
      text: '数据库迁移脚本我提交了，今晚会在预发环境验证。',
    }),
    msg({
      ...g2,
      senderId: '20004',
      senderName: '设计',
      minutes: -300,
      text: '新版首页视觉稿已上传：https://example.com/design-v3',
    }),
    msg({
      ...g2,
      senderId: '20003',
      senderName: '测试',
      minutes: -200,
      text: '今天发现一个阻塞问题，登录偶现超时，谁来看一下？',
    }),
    msg({
      ...g2,
      senderId: '20001',
      senderName: '产品经理',
      senderRole: 'admin',
      minutes: -120,
      text: '明天上午10点复盘会，把这次延迟的原因过一遍。',
    }),
    msg({
      ...g2,
      senderId: '20005',
      senderName: '实习生',
      minutes: -45,
      text: '哈哈哈',
    }),
  ];
}

export function demoFollows() {
  return [
    { platform: 'qq', chatId: 'demo-group-algo', userId: '10001', userName: '队长', priority: 'high', note: '集训负责人，通知以他为准' },
    { platform: 'qq', chatId: 'demo-group-algo', userId: '10002', userName: '指导老师', priority: 'normal', note: '评审方向' },
    { platform: 'qq', chatId: 'demo-group-project', userId: '20001', userName: '产品经理', priority: 'high', note: '需求与排期' },
  ];
}
