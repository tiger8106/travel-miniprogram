// services/mock-data.js
// 本地 mock 数据 —— 当 USE_MOCK=true 时使用，无需云开发
//
// 这里的内容是**真实从 Tiger 上传的 docx 里提取**的行程
// （docx 在 D:\Tige-yyds\个人资料\个人\国庆七天广西旅游攻略.docx）

const TRIP_ID = 'mock-trip-guangxi-real-001';

// ============================================================================
// 行程数据 —— 9 天行程（9月30日出发 ~ 10月7日返回）
// ============================================================================
const MOCK_TRIP = {
  _id: TRIP_ID,
  tripId: TRIP_ID,
  title: '国庆广西 9 天深度游',
  subtitle: '重庆 - 桂林 - 龙脊 - 阳朔 - 德天 - 南宁 - 重庆',
  destination: '广西',
  startDate: '2026-09-30',
  endDate: '2026-10-07',
  days: 9,
  items: [
    // -------- Day 0: 9月30日｜重庆 → 桂林 --------
    {
      _id: 'it01', dayIndex: 0,
      startTime: '12:00', endTime: '13:30',
      activity: '吃午饭，准备出发',
      startLocation: '重庆北站', endLocation: null,
      transportType: 'walk', category: 'food',
      note: '建议 13:30 前到重庆北站',
    },
    {
      _id: 'it02', dayIndex: 0,
      startTime: '14:44', endTime: '19:38',
      activity: '高铁 G2249 重庆 → 桂林西',
      startLocation: '重庆北站', endLocation: '桂林西站',
      transportType: 'train', category: 'transit',
      note: '高铁 G2249，约 5 小时',
    },
    {
      _id: 'it03', dayIndex: 0,
      startTime: '20:10', endTime: '21:00',
      activity: '崇善米粉一号店（桂林米粉第一顿）',
      startLocation: '崇善米粉一号店', endLocation: null,
      transportType: 'walk', category: 'food',
      note: '必点：卤菜粉 / 锅烧粉',
    },
    {
      _id: 'it04', dayIndex: 0,
      startTime: '21:00', endTime: '22:30',
      activity: '东西巷 + 杉湖看日月双塔夜景',
      startLocation: '东西巷', endLocation: '杉湖',
      transportType: 'walk', category: 'sight',
      note: '步行约 1.5 小时',
    },
    // -------- Day 1: 10月1日｜桂林 → 龙脊梯田 --------
    {
      _id: 'it11', dayIndex: 1,
      startTime: '08:00', endTime: '10:30',
      activity: '直通车去金坑大寨',
      startLocation: '桂林站', endLocation: '金坑大寨停车场',
      transportType: 'car', category: 'transit',
      note: '正常 2.5 小时，微信联系"桂林龙脊梯田旅游车队"',
    },
    {
      _id: 'it12', dayIndex: 1,
      startTime: '11:20', endTime: '11:30',
      activity: '入住龙脊别院（西山韶乐店）',
      startLocation: '金坑大寨', endLocation: '田头寨',
      transportType: 'walk', category: 'hotel',
      note: '报酒店名字购票 20 元/人',
    },
    {
      _id: 'it13', dayIndex: 1,
      startTime: '11:30', endTime: '13:00',
      activity: '田头寨吃午饭（竹筒鸡、竹筒饭、腊肉炒笋、禾花鱼）',
      startLocation: '龙脊别院（西山韶乐店）', endLocation: null,
      transportType: 'walk', category: 'food',
      note: '民宿午饭',
    },
    {
      _id: 'it14', dayIndex: 1,
      startTime: '13:00', endTime: '14:30',
      activity: '千层天梯观景',
      startLocation: '千层天梯观景台', endLocation: null,
      transportType: 'walk', category: 'sight',
      note: '龙脊别院到千层天梯 1 公里，步行半小时',
    },
    {
      _id: 'it15', dayIndex: 1,
      startTime: '15:30', endTime: '18:30',
      activity: '金佛顶看日落（缆车上）',
      startLocation: '龙脊索道（出站口）', endLocation: '金佛顶',
      transportType: 'ride', category: 'sight',
      note: '缆车末班车 17:30-18:30 之间，注意确认',
    },
    // -------- Day 2: 10月2日｜龙脊日出 → 桂林 --------
    {
      _id: 'it21', dayIndex: 2,
      startTime: '06:00', endTime: '07:30',
      activity: '西山韶乐看日出',
      startLocation: '龙脊别院', endLocation: '西山韶乐',
      transportType: 'walk', category: 'sight',
      note: '日出大概 6:30',
    },
    {
      _id: 'it22', dayIndex: 2,
      startTime: '10:00', endTime: '14:00',
      activity: '返回桂林',
      startLocation: '田头寨', endLocation: '桂林市区',
      transportType: 'car', category: 'transit',
      note: '尽量订 11 点左右返回桂林的直通车',
    },
    {
      _id: 'it23', dayIndex: 2,
      startTime: '14:30', endTime: '16:00',
      activity: '象鼻山主景',
      startLocation: '象鼻山', endLocation: null,
      transportType: 'walk', category: 'sight',
      note: '江边拍照',
    },
    {
      _id: 'it24', dayIndex: 2,
      startTime: '16:00', endTime: '17:30',
      activity: '杉湖、榕湖两江四湖漫步',
      startLocation: '杉湖', endLocation: '榕湖',
      transportType: 'walk', category: 'sight',
      note: '不坐游船（明天有漓江游船）',
    },
    {
      _id: 'it25', dayIndex: 2,
      startTime: '18:00', endTime: '19:30',
      activity: '椿记烧鹅晚饭（中山中路店）',
      startLocation: '椿记烧鹅中山中路店', endLocation: null,
      transportType: 'walk', category: 'food',
      note: '必点：烧鹅 + 荔浦芋扣肉',
    },
    // -------- Day 3: 10月3日｜漓江游船 → 阳朔 --------
    {
      _id: 'it31', dayIndex: 3,
      startTime: '08:30', endTime: '13:30',
      activity: '漓江四星游船（竹江码头）',
      startLocation: '桂林竹江码头', endLocation: '阳朔',
      transportType: 'transit', category: 'sight',
      note: '九马画山、黄布倒影、兴坪都在这条线。**船票必须提前抢**，每天 11:00、16:00 更新余票',
    },
    {
      _id: 'it32', dayIndex: 3,
      startTime: '14:30', endTime: '15:00',
      activity: '阳朔酒店放行李 + 休息',
      startLocation: '阳朔酒店', endLocation: null,
      transportType: 'walk', category: 'hotel',
      note: '建议住遇龙河/十里画廊，不住西街中心',
    },
    {
      _id: 'it33', dayIndex: 3,
      startTime: '16:00', endTime: '18:00',
      activity: '兴坪古镇 + 20 元人民币背景',
      startLocation: '阳朔', endLocation: '兴坪古镇',
      transportType: 'car', category: 'sight',
      note: '国庆阳朔到兴坪容易堵，15 点前出发',
    },
    {
      _id: 'it34', dayIndex: 3,
      startTime: '19:30', endTime: '21:00',
      activity: '啤酒鱼晚饭',
      startLocation: '阳朔西街', endLocation: null,
      transportType: 'walk', category: 'food',
      note: '谢大姐 / 谢三姐',
    },
    // -------- Day 4: 10月4日｜阳朔深度 --------
    {
      _id: 'it41', dayIndex: 4,
      startTime: '09:00', endTime: '11:00',
      activity: '遇龙河双人竹筏',
      startLocation: '遇龙河', endLocation: null,
      transportType: 'ride', category: 'sight',
      note: '1.5 小时',
    },
    {
      _id: 'it42', dayIndex: 4,
      startTime: '13:00', endTime: '17:00',
      activity: '十里画廊骑行',
      startLocation: '十里画廊', endLocation: null,
      transportType: 'ride', category: 'sight',
      note: '租电动车，沿途月亮山 / 大榕树',
    },
    // -------- Day 5: 10月5日｜阳朔 → 崇左 → 德天 --------
    {
      _id: 'it51', dayIndex: 5,
      startTime: '09:00', endTime: '14:00',
      activity: '阳朔 → 崇左明仕田园',
      startLocation: '阳朔', endLocation: '明仕田园',
      transportType: 'car', category: 'transit',
      note: '包车或班车，约 5 小时',
    },
    {
      _id: 'it52', dayIndex: 5,
      startTime: '15:00', endTime: '17:00',
      activity: '德天跨国瀑布',
      startLocation: '明仕田园', endLocation: '德天瀑布',
      transportType: 'car', category: 'sight',
      note: '中越边境',
    },
    // -------- Day 6: 10月6日｜崇左 → 南宁 --------
    {
      _id: 'it61', dayIndex: 6,
      startTime: '09:00', endTime: '13:00',
      activity: '崇左 → 南宁',
      startLocation: '崇左', endLocation: '南宁',
      transportType: 'car', category: 'transit',
      note: '约 4 小时',
    },
    {
      _id: 'it62', dayIndex: 6,
      startTime: '15:00', endTime: '18:00',
      activity: '青秀山',
      startLocation: '青秀山', endLocation: null,
      transportType: 'walk', category: 'sight',
      note: '南宁地标',
    },
    {
      _id: 'it63', dayIndex: 6,
      startTime: '19:00', endTime: '21:00',
      activity: '中山路美食街',
      startLocation: '中山路美食街', endLocation: null,
      transportType: 'walk', category: 'food',
      note: '老友粉 / 螺蛳粉 / 酸嘢',
    },
    // -------- Day 7: 10月7日｜南宁 → 重庆 --------
    {
      _id: 'it71', dayIndex: 7,
      startTime: '09:00', endTime: '11:00',
      activity: '南宁机场 → 重庆机场',
      startLocation: '南宁吴圩国际机场', endLocation: '重庆江北机场',
      transportType: 'plane', category: 'transit',
      note: '航班 3U8XXX',
    },
  ],
};

// ============================================================================
// 闹钟数据 —— 用相对当前时间的偏移，方便测试
// ============================================================================
function alarmAt(minutesFromNow) {
  const t = new Date();
  t.setMinutes(t.getMinutes() + minutesFromNow);
  const fireAt = t.getTime();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const fireAtStr = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  return {
    fireAt,
    fireAtStr,
    triggerAt: fireAt - 5 * 60 * 1000,
    remindAt: fireAt - 5 * 60 * 1000,
    leadMinutes: 5,
    completed: false,
  };
}

const MOCK_ALARMS = [
  // 第 1 条：5 分钟后触发 —— **马上能体验震动效果**
  {
    _id: 'a1', tripId: TRIP_ID,
    title: '🚨 测试闹钟（演示用）',
    ...alarmAt(5),
    leadMinutes: 5,
    note: '5 分钟后会自动震动 + 弹窗，用来演示闹钟功能',
  },
  // 抢票相关
  {
    _id: 'a2', tripId: TRIP_ID,
    title: '抢漓江四星船票（10月3日）',
    ...alarmAt(60),   // 1 小时后
    leadMinutes: 5,
    usageInfo: '使用时间：2026-10-03 08:30-13:30；漓江四星游船（竹江码头）',
    note: '船票最难抢，每天 11:00、16:00 更新余票',
  },
  {
    _id: 'a3', tripId: TRIP_ID,
    title: '订阳朔酒店（10月3-5日）',
    ...alarmAt(120),  // 2 小时后
    leadMinutes: 5,
    usageInfo: '住宿：2026-10-03 至 2026-10-06；阳朔酒店',
    note: '建议住遇龙河/十里画廊',
  },
  {
    _id: 'a4', tripId: TRIP_ID,
    title: '订德天瀑布门票',
    ...alarmAt(180),  // 3 小时后
    leadMinutes: 10,
    usageInfo: '使用时间：2026-10-06 15:00-17:00；德天跨国瀑布',
    note: '',
  },
  {
    _id: 'a5', tripId: TRIP_ID,
    title: '值机选座（回程）',
    ...alarmAt(240),  // 4 小时后
    leadMinutes: 30,
    note: '起飞前 24h 开放',
  },
];

// ============================================================================
// 旅行建议
// ============================================================================
const MOCK_SUGGESTIONS = {
  tripId: TRIP_ID,
  generatedAt: Date.now(),
  weather: [
    '10 月初广西气温 22-32℃，桂林/龙脊早晚凉（15℃ 左右），带薄外套',
    '桂林 10 月雨水不多，但龙脊山路湿滑，穿防滑鞋',
    '德天瀑布在亚热带，紫外线强，SPF50+ 防晒必备',
  ],
  gear: [
    '**充电宝必带**（龙脊山里充电不便）',
    '**防滑徒步鞋**（龙脊梯田全是台阶）',
    '**晕船药**（漓江游船 4 小时）',
    '**保暖外套**（龙脊山顶看日出很冷）',
    '**一次性雨衣**（万一下雨）',
  ],
  food: [
    '桂林：崇善米粉（卤菜粉/锅烧粉）、椿记烧鹅',
    '阳朔：谢大姐啤酒鱼、谢三姐啤酒鱼',
    '德天：越南鸡肉粉、边境烧烤',
    '南宁：舒记老友粉、中山路螺蛳粉',
  ],
  play: [
    '**漓江四星游船**（九马画山、黄布倒影、兴坪 20 元背景都在这条线）',
    '**龙脊金佛顶看日落**（视野最开阔）',
    '**西山韶乐看日出**（田头寨附近）',
    '**兴坪古镇**（亲自拿 20 元纸币打卡背景）',
    '**德天跨国瀑布**（中越边境，可坐竹筏）',
  ],
  tips: [
    '**国庆船票必须提前抢**！提前 10 天留意，每天 11:00、16:00 更新余票',
    '阳朔不住西街中心（吵），建议住遇龙河/十里画廊',
    '龙脊金坑大寨**报酒店名字购票 20 元/人**，不报 50 元',
    '缆车末班车时间**进景区后确认**，以免错过',
    '阳朔到兴坪国庆容易堵，**15 点前出发**',
  ],
  cost: [
    '交通（高铁+包车+飞机）：约 3500 元',
    '住宿（8 晚）：约 2200 元',
    '餐饮：约 1000 元',
    '门票+船票+包车：约 1200 元',
    '**人均：7900 元**',
  ],
};

// ============================================================================
// 内存中的可变数据副本
// ============================================================================
const STORE = {
  itinerary: JSON.parse(JSON.stringify(MOCK_TRIP)),
  alarms: JSON.parse(JSON.stringify(MOCK_ALARMS)),
  suggestions: JSON.parse(JSON.stringify(MOCK_SUGGESTIONS)),
};

module.exports = {
  TRIP_ID,
  STORE,
};
