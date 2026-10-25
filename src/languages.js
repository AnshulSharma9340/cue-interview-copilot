// Whisper language codes offered in the session language dropdown.
const LANGUAGES = [
  ['auto', 'Auto-detect'], ['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['pl', 'Polish'],
  ['tr', 'Turkish'], ['ar', 'Arabic'], ['fa', 'Persian'], ['ur', 'Urdu'], ['bn', 'Bengali'], ['ta', 'Tamil'],
  ['te', 'Telugu'], ['mr', 'Marathi'], ['gu', 'Gujarati'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['pa', 'Punjabi'],
  ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['id', 'Indonesian'],
  ['ms', 'Malay'], ['tl', 'Tagalog'], ['ro', 'Romanian'], ['el', 'Greek'], ['sv', 'Swedish'], ['da', 'Danish'],
  ['no', 'Norwegian'], ['fi', 'Finnish'], ['cs', 'Czech'], ['sk', 'Slovak'], ['hu', 'Hungarian'], ['bg', 'Bulgarian'],
  ['hr', 'Croatian'], ['sr', 'Serbian'], ['sl', 'Slovenian'], ['he', 'Hebrew'], ['sw', 'Swahili'], ['af', 'Afrikaans'],
  ['ca', 'Catalan'], ['lt', 'Lithuanian'], ['lv', 'Latvian'], ['et', 'Estonian'],
];
const LANG_NAMES = Object.fromEntries(LANGUAGES);

module.exports = { LANGUAGES, LANG_NAMES };
