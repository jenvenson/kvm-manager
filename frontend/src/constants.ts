import type { BadgeProps } from 'antd'

export const STATE_COLOR: Record<string, BadgeProps['status']> = {
  running: 'success',
  shutoff: 'default',
  paused: 'warning',
  crashed: 'error',
}
