import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['dist/', '.parcel-cache/', 'node_modules/', 'data/']
  },
  js.configs.recommended,
  {
    // Frontend, bundled by Parcel
    files: ['assets/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser
    }
  },
  {
    // Backend and maintenance scripts, run directly by Node.js
    files: ['main.js', 'lib/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node
    }
  }
]
