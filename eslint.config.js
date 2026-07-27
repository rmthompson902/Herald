'use strict';

// Flat config (ESLint v9). Three source contexts: Node CommonJS for the engine/glue
// (lib/, node-red/, scripts/, test/), Jest for the unit tests, and browser scripts for the
// webapp's vanilla ES modules (loaded as plain <script> tags, so cross-file classes like
// ScheduleAPI are real globals, not imports). Prettier owns formatting; this file only
// carries correctness rules. no-console is off on purpose - the code uses console as a
// deliberate dependency-free last-resort fallback in several places (see oscClient.js).

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

// Globals the webapp's browser scripts define in one file and consume in others (plain
// <script> load order, no bundler), plus the third-party libs loaded in base.html.
const webappGlobals = {
  bootstrap: 'readonly',
  io: 'readonly',
  socket: 'readonly',
  showToast: 'readonly',
  AppConstants: 'readonly',
  TimeFormat: 'readonly',
  APIClient: 'readonly',
  ScheduleAPI: 'readonly',
  VogAPI: 'readonly',
  CueAPI: 'readonly',
  HistoryAPI: 'readonly',
  QueueAPI: 'readonly',
  ZoneAPI: 'readonly',
  ButtonStateManager: 'readonly',
  ModalManager: 'readonly',
  TooltipManager: 'readonly',
  CuePicker: 'readonly'
};

module.exports = [
  {
    ignores: [
      'node_modules/',
      'webapp/.venv/',
      'webapp/static/vendor/',
      'data/',
      'logs/',
      'media/',
      '_old/',
      'coverage/',
      'node-red/flows.json',
      'node-red/.config.*'
    ]
  },
  js.configs.recommended,
  {
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['lib/**/*.js', 'node-red/**/*.js', 'scripts/**/*.js', 'test/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.jest } }
  },
  {
    files: ['webapp/static/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...webappGlobals }
    },
    rules: {
      // These app classes are declared in one browser script and referenced as globals in
      // others - the config globals above make that legal, so the defining file's own
      // top-level declaration must not be flagged as redeclaring a builtin.
      'no-redeclare': ['error', { builtinGlobals: false }]
    }
  },
  prettier
];
