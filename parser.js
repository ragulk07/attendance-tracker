const cheerio = require('cheerio');

const STATUSES = ['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY', 'UPCOMING'];
const DATE_REGEX = /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/;

/**
 * Parse calculation string according to specification
 * @param {string} lineOrCalc 
 * @returns {{ weight: number, status: string, rawLabel: string | null } | null}
 */
function parseCalculation(lineOrCalc) {
  const notCountedMatch = lineOrCalc.match(/not counted:\s*([a-z0-9\s_-]+)/i);
  const countsMatch = lineOrCalc.match(/counts\s+([\d.]+)\s+as\s+([a-z0-9_-]+)/i);

  if (notCountedMatch) {
    const rawReason = notCountedMatch[1].trim().toUpperCase();
    if (rawReason === 'HOLIDAY') {
      return { status: 'HOLIDAY', weight: 2, rawLabel: null };
    }
    return { status: 'UPCOMING', weight: 2, rawLabel: null };
  }

  if (countsMatch) {
    const weight = parseFloat(countsMatch[1]);
    const label = countsMatch[2].trim().toUpperCase();
    if (['PRESENT', 'ABSENT', 'LEAVE'].includes(label)) {
      return { status: label, weight, rawLabel: null };
    }
    // Unknown labels such as ML, OD, CL: status = ABSENT, keep the original in rawLabel
    return { status: 'ABSENT', weight, rawLabel: label };
  }

  // Fallback direct match if calculation column text is just status
  const fallback = lineOrCalc.match(/\b(PRESENT|ABSENT|LEAVE|HOLIDAY|UPCOMING)\b/i);
  if (fallback) {
    const st = fallback[1].toUpperCase();
    return { status: st, weight: 2, rawLabel: null };
  }

  return null;
}

/**
 * Parse an HTML table or HTML document containing attendance rows
 * @param {string} html 
 * @returns {Array<{ date: string, time: string, timing: string, status: string, originalStatus: string, weight: number, rawLabel: string | null }>}
 */
function parseAttendanceHtml(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $('tr').each((_, tr) => {
    const cells = $(tr).find('td, th').map((__, cell) => $(cell).text().trim()).get();
    if (cells.length < 2) return;

    const first = cells[0];
    if (/^date$/i.test(first)) return;
    if (!DATE_REGEX.test(first)) return;

    const date = cells[0];
    const time = cells[1] || '';
    const timing = cells[2] || '';
    // Location: cells[3]
    // Attendance: cells[4]
    // Calculation: cells[5]
    // Feedback: cells[6]
    const calculationCol = cells[5] || cells.join(' ');

    const parsed = parseCalculation(calculationCol);
    if (!parsed) return;

    rows.push({
      date,
      time,
      timing,
      status: parsed.status,
      originalStatus: parsed.status,
      weight: parsed.weight,
      rawLabel: parsed.rawLabel
    });
  });

  return rows;
}

/**
 * Parse raw tab-delimited or whitespace-delimited text lines (matching client paste logic)
 * @param {string} text 
 * @returns {Array<{ date: string, time: string, timing: string, status: string, originalStatus: string, weight: number, rawLabel: string | null }>}
 */
function parseAttendanceText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const rows = [];

  for (const line of lines) {
    let cols = line.split('\t').map(c => c.trim()).filter(c => c.length > 0);
    if (cols.length < 3) {
      cols = line.split(/\s{2,}/).map(c => c.trim());
    }
    if (cols.length < 2) continue;

    const first = cols[0];
    if (/^date$/i.test(first)) continue;
    if (!DATE_REGEX.test(first)) continue;

    const date = cols[0];
    const time = cols[1] || '';
    const timing = cols[2] || '';

    const parsed = parseCalculation(line);
    if (!parsed) continue;

    rows.push({
      date,
      time,
      timing,
      status: parsed.status,
      originalStatus: parsed.status,
      weight: parsed.weight,
      rawLabel: parsed.rawLabel
    });
  }

  return rows;
}

/**
 * General parser accepting either HTML or raw text
 * @param {string} input 
 */
function parseAttendanceRows(input) {
  if (typeof input !== 'string') return [];
  if (/<(tr|table|td)/i.test(input)) {
    return parseAttendanceHtml(input);
  }
  return parseAttendanceText(input);
}

/**
 * Calculate attendance statistics and percentage
 * Percentage = present weight / (present + absent + leave weight) * 100
 * Holidays and upcoming rows are excluded.
 * @param {Array<{ status: string, weight: number }>} rows 
 */
function calculateAttendanceStats(rows) {
  let present = 0;
  let absent = 0;
  let leave = 0;
  let holiday = 0;
  let upcoming = 0;

  for (const r of rows) {
    const w = typeof r.weight === 'number' ? r.weight : 2;
    if (r.status === 'PRESENT') {
      present += w;
    } else if (r.status === 'ABSENT') {
      absent += w;
    } else if (r.status === 'LEAVE') {
      leave += w;
    } else if (r.status === 'HOLIDAY') {
      holiday += w;
    } else if (r.status === 'UPCOMING') {
      upcoming += w;
    }
  }

  const countedTotal = present + absent + leave;
  const percentage = countedTotal > 0 ? (present / countedTotal) * 100 : 0;

  return {
    present,
    absent,
    leave,
    holiday,
    upcoming,
    countedTotal,
    percentage: Math.round(percentage * 100) / 100
  };
}

module.exports = {
  STATUSES,
  parseCalculation,
  parseAttendanceHtml,
  parseAttendanceText,
  parseAttendanceRows,
  calculateAttendanceStats
};
