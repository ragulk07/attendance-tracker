const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseAttendanceRows,
  parseCalculation,
  calculateAttendanceStats
} = require('../parser');

test('parseCalculation handles all standard and edge cases', () => {
  // Counts X.XX as <Label>
  assert.deepEqual(parseCalculation('Counts 2.00 as Present'), {
    status: 'PRESENT',
    weight: 2,
    rawLabel: null
  });
  assert.deepEqual(parseCalculation('Counts 1.50 as Absent'), {
    status: 'ABSENT',
    weight: 1.5,
    rawLabel: null
  });
  assert.deepEqual(parseCalculation('Counts 0.75 as Leave'), {
    status: 'LEAVE',
    weight: 0.75,
    rawLabel: null
  });

  // Not counted: Holiday
  assert.deepEqual(parseCalculation('Not counted: Holiday'), {
    status: 'HOLIDAY',
    weight: 2,
    rawLabel: null
  });

  // Not counted: <anything else> -> UPCOMING, weight = 2
  assert.deepEqual(parseCalculation('Not counted: Yet to be conducted'), {
    status: 'UPCOMING',
    weight: 2,
    rawLabel: null
  });
  assert.deepEqual(parseCalculation('Not counted: Future Class'), {
    status: 'UPCOMING',
    weight: 2,
    rawLabel: null
  });

  // Unknown labels: ML, OD, CL -> ABSENT with rawLabel preserved
  assert.deepEqual(parseCalculation('Counts 2.00 as OD'), {
    status: 'ABSENT',
    weight: 2,
    rawLabel: 'OD'
  });
  assert.deepEqual(parseCalculation('Counts 2.00 as ML'), {
    status: 'ABSENT',
    weight: 2,
    rawLabel: 'ML'
  });
  assert.deepEqual(parseCalculation('Counts 1.00 as CL'), {
    status: 'ABSENT',
    weight: 1,
    rawLabel: 'CL'
  });
});

test('parseAttendanceRows parses fixture HTML correctly', () => {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'attendance-table.html');
  const fixtureHtml = fs.readFileSync(fixturePath, 'utf8');

  const rows = parseAttendanceRows(fixtureHtml);

  // Check expected count: 7 valid rows (header and summary skipped)
  assert.equal(rows.length, 7);

  // Row 1: Present
  assert.equal(rows[0].date, '16 Jul 2026');
  assert.equal(rows[0].time, '10:00 - 11:59');
  assert.equal(rows[0].timing, 'CLS10-12');
  assert.equal(rows[0].status, 'PRESENT');
  assert.equal(rows[0].originalStatus, 'PRESENT');
  assert.equal(rows[0].weight, 2);
  assert.equal(rows[0].rawLabel, null);

  // Row 2: Absent
  assert.equal(rows[1].date, '17 Jul 2026');
  assert.equal(rows[1].status, 'ABSENT');
  assert.equal(rows[1].weight, 2);

  // Row 3: Leave
  assert.equal(rows[2].date, '18 Jul 2026');
  assert.equal(rows[2].status, 'LEAVE');
  assert.equal(rows[2].weight, 1.5);

  // Row 4: Holiday
  assert.equal(rows[3].date, '19 Jul 2026');
  assert.equal(rows[3].status, 'HOLIDAY');
  assert.equal(rows[3].weight, 2);

  // Row 5: Upcoming
  assert.equal(rows[4].date, '20 Jul 2026');
  assert.equal(rows[4].status, 'UPCOMING');
  assert.equal(rows[4].weight, 2);

  // Row 6: OD (Unknown label counted as ABSENT)
  assert.equal(rows[5].date, '21 Jul 2026');
  assert.equal(rows[5].status, 'ABSENT');
  assert.equal(rows[5].weight, 2);
  assert.equal(rows[5].rawLabel, 'OD');

  // Row 7: ML (Unknown label counted as ABSENT)
  assert.equal(rows[6].date, '22 Jul 2026');
  assert.equal(rows[6].status, 'ABSENT');
  assert.equal(rows[6].weight, 2);
  assert.equal(rows[6].rawLabel, 'ML');
});

test('parseAttendanceRows parses tab-separated raw text correctly', () => {
  const text = `
Date\tTime\tTiming\tLocation\tAttendance\tCalculation\tFeedback
16 Jul 2026\t10:00 - 11:59\tCLS10-12\t2853\tPRESENT\tCounts 2.00 as Present\tN/A
17 Jul 2026\t08:00 - 09:59\tCLS08-10\t2853\tABSENT\tCounts 2.00 as Absent\tN/A
18 Jul 2026\t13:00 - 14:59\tCLS13-15\t2853\tLEAVE\tCounts 1.00 as Leave\tApproved
Invalid Row Text
`;
  const rows = parseAttendanceRows(text);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, 'PRESENT');
  assert.equal(rows[1].status, 'ABSENT');
  assert.equal(rows[2].status, 'LEAVE');
});

test('calculateAttendanceStats computes percentages excluding holidays and upcoming', () => {
  const rows = [
    { status: 'PRESENT', weight: 2 },
    { status: 'PRESENT', weight: 2 },
    { status: 'ABSENT', weight: 2 },
    { status: 'LEAVE', weight: 1.5 },
    { status: 'HOLIDAY', weight: 2 }, // excluded
    { status: 'UPCOMING', weight: 2 }  // excluded
  ];

  // Present weight = 4. Counted total = 2 + 2 + 2 + 1.5 = 7.5
  // Percentage = 4 / 7.5 * 100 = 53.33%
  const stats = calculateAttendanceStats(rows);
  assert.equal(stats.present, 4);
  assert.equal(stats.absent, 2);
  assert.equal(stats.leave, 1.5);
  assert.equal(stats.holiday, 2);
  assert.equal(stats.upcoming, 2);
  assert.equal(stats.countedTotal, 7.5);
  assert.equal(stats.percentage, 53.33);
});

test('calculateAttendanceStats returns 0 when no counted sessions exist', () => {
  const rows = [
    { status: 'HOLIDAY', weight: 2 },
    { status: 'UPCOMING', weight: 2 }
  ];
  const stats = calculateAttendanceStats(rows);
  assert.equal(stats.countedTotal, 0);
  assert.equal(stats.percentage, 0);
});
