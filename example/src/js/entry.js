import { greet } from '@/js/lib'

export const entry = {
  api: process.env.API_URL,
  message: greet('deltic'),
}
