export function notesListEmptyCopy(input: {
  query?: string;
  folderName?: string | null;
  showArchived: boolean;
  favouritesOnly: boolean;
}): { title: string; message: string } {
  if (input.query?.trim()) {
    return {
      title: 'No matching notes',
      message: 'Nothing in this search. Try a different word or clear the search.',
    };
  }
  if (input.showArchived) {
    return {
      title: 'No archived notes',
      message: 'Archived notes will appear here. Your active notes are unchanged.',
    };
  }
  if (input.favouritesOnly) {
    return {
      title: 'No favourite notes',
      message: 'Mark a note as favourite to see it in this filter.',
    };
  }
  if (input.folderName) {
    return {
      title: `No notes in ${input.folderName}`,
      message: 'This folder is empty. Create a note here or switch to All.',
    };
  }
  return {
    title: 'No notes yet',
    message: 'No notes yet. Capture an idea, plan or reminder.',
  };
}
