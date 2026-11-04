import { Plugin, Slot, Style } from "@opencode/plugin/gui"
import styles from "./gui/badge.css?inline"
import { TpsBadge } from "./gui/badge"

export default Plugin.define({
  setup(ctx) {
    const countReasoning = ctx.options.countReasoning !== false

    ctx.add(Style, styles)
    ctx.add(Slot, {
      at: "session.header",
      order: 20,
      render: (input) => (
        <TpsBadge session={input.session} compact={input.compact} countReasoning={countReasoning} />
      ),
    })
  },
})
