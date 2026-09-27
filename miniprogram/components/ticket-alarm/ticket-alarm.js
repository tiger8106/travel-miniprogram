// components/ticket-alarm/ticket-alarm.js
// 纯展示组件：闹钟卡片 + 操作按钮，编辑/删除弹层统一由 tickets 页面管理
Component({
  properties: {
    item: {
      type: Object,
      value: {},
    },
    // 是否显示调试用的「🔔 测试」按钮（正式版由页面传入 false）
    devMode: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    icon: '⏰',
    statusLabel: '未知',
  },

  observers: {
    item(item) {
      if (!item) return;
      this.setData({
        icon: ({
          train: '🚄', plane: '✈️', ticket: '🎫',
          hotel: '🏨', bus: '🚌', other: '⏰',
        })[item.type] || '⏰',
        statusLabel: ({
          completed: '已完成', past: '已逾期', soon: '即将提醒', future: '未来', unknown: '未知',
        })[item.status] || '未知',
      });
    },
  },

  methods: {
    onTapEdit() {
      this.triggerEvent('tapedit', { item: this.data.item });
    },

    onTapDelete() {
      this.triggerEvent('tapdelete', { item: this.data.item });
    },

    onTapComplete() {
      this.triggerEvent('togglecomplete', { item: this.data.item });
    },

    onTapTest() {
      this.triggerEvent('taptest', { item: this.data.item });
    },

    onTapCalendar() {
      this.triggerEvent('tapcalendar', { item: this.data.item });
    },
  },
});
