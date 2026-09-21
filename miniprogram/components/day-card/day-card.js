// components/day-card/day-card.js
Component({
  properties: {
    day: {
      type: Object,
      value: {},
    },
    isToday: {
      type: Boolean,
      value: false,
    },
  },

  methods: {
    onTap() {
      this.triggerEvent('tap', { day: this.data.day });
    },
  },
});