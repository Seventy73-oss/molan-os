const LAST_OPENED_BOOK_KEY = "molan.last-opened-book";

/** A device-local shortcut only; no manuscript content is stored here. */
export function getLastOpenedBookId(): string | null {
  try {
    return localStorage.getItem(LAST_OPENED_BOOK_KEY);
  } catch {
    return null;
  }
}

/** Call only after a book has opened successfully, not on a navigation attempt. */
export function rememberOpenedBook(bookId: string): void {
  try {
    localStorage.setItem(LAST_OPENED_BOOK_KEY, bookId);
  } catch {
    // Private browsing or blocked storage must never interrupt writing.
  }
}
