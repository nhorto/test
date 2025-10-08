// https://www.sanity.io/docs/structure-builder-cheat-sheet
export const structure = (S) =>
  S.list()
    .title('Blog')
    .items([
      S.documentTypeListItem('blogPost').title('Blog Posts'),
      S.documentTypeListItem('blogCategory').title('Blog Categories'),
      S.divider(),
      ...S.documentTypeListItems().filter(
        (item) => item.getId() && !['blogPost', 'blogCategory'].includes(item.getId()),
      ),
    ])
