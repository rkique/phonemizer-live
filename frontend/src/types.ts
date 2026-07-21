export type View = "recordings" | "inventory";

export interface TranscriptUnit {
  kind: "phoneme" | "gap";
  ch: string;
  start: number;
  end: number;
  word_start?: boolean;
}

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
  pinyin?: string;
}

export interface Transcript {
  id: number;
  text: string;
  ipa: string;
  duration: number;
  units: TranscriptUnit[];
  words: WordTimestamp[];
  audio_url: string | null;
  spectrogram_url: string | null;
  created_at: string;
  language: string;
  language_label: string;
  is_sample: boolean;
}

export interface Language {
  code: string;
  label: string;
}

export interface PhonemeExample {
  transcript_id: number;
  word: string;
  start: number;
  end: number;
}

export interface PhonemeInventoryEntry {
  symbol: string;
  category: string;
  count: number;
  examples: PhonemeExample[];
}

export interface DriveStatus {
  linked: boolean;
  email: string | null;
}
