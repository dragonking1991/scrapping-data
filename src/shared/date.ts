export function isValidDateInput(value: string): boolean {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
    return false;
  }

  const [dayRaw, monthRaw, yearRaw] = value.split("/");
  const day = Number(dayRaw);
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  const date = new Date(year, month - 1, day);
  return (
    Number.isInteger(day) &&
    Number.isInteger(month) &&
    Number.isInteger(year) &&
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

// GDT API expects DD/MM/YYYY format (same order as user input), e.g. 02/06/2026T00:00:00
export function toApiDateStart(value: string): string {
  return `${value}T00:00:00`;
}

// GDT uses tdlap=le= (less-than-or-equal) with end-of-day, not tdlap=lt= with next-day
export function toApiDateExclusiveEnd(value: string): string {
  return `${value}T23:59:59`;
}

export function toApiDateEnd(value: string): string {
  return `${value}T23:59:59`;
}
