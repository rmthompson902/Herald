'use strict';

const { deriveZoneSuggestion } = require('../../lib/zones/zoneNamingConvention');

describe('deriveZoneSuggestion', () => {
  it('derives Zone 1 from a real Zone 1 message cue number', () => {
    expect(deriveZoneSuggestion('1101')).toEqual({
      zoneName: 'Zone 1',
      duckCueNumber: '1198',
      unduckCueNumber: '1199'
    });
  });

  it('derives Zone 3 from a real Zone 3 message cue number', () => {
    expect(deriveZoneSuggestion('3103')).toEqual({
      zoneName: 'Zone 3',
      duckCueNumber: '3198',
      unduckCueNumber: '3199'
    });
  });

  it('derives a suggestion even for a cue number that does not exist yet (pattern-only match)', () => {
    expect(deriveZoneSuggestion('4100')).toEqual({
      zoneName: 'Zone 4',
      duckCueNumber: '4198',
      unduckCueNumber: '4199'
    });
  });

  it('accepts a numeric cueNumber argument, not just a string', () => {
    expect(deriveZoneSuggestion(3101)).toEqual({
      zoneName: 'Zone 3',
      duckCueNumber: '3198',
      unduckCueNumber: '3199'
    });
  });

  it('returns null for a cue number with a zero leading digit', () => {
    expect(deriveZoneSuggestion('0101')).toBeNull();
  });

  it('returns null when the second digit is not "1" (not the messaging-tier marker)', () => {
    expect(deriveZoneSuggestion('1201')).toBeNull();
  });

  it('returns null for a 3-digit cue number', () => {
    expect(deriveZoneSuggestion('101')).toBeNull();
  });

  it('returns null for a 5-digit cue number', () => {
    expect(deriveZoneSuggestion('31010')).toBeNull();
  });

  it('returns null for a non-numeric cue number', () => {
    expect(deriveZoneSuggestion('abcd')).toBeNull();
  });

  it('returns null for a real Group cue number that does not follow the convention', () => {
    expect(deriveZoneSuggestion('9900')).toBeNull();
  });
});
