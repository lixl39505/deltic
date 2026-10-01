import { defineConfig, preset } from 'deltic'

export default defineConfig({
  alias: {
    '@': './src',
  },

  env: {
    API_URL: 'https://api.example.com',
  },

  // loadEnv: true,   // read .env / .env.[mode] files (never touches process.env)
  // profile: true,   // report the slowest pipes and files after each compile

  tasks: preset(),
})
