export type ReviewDiffDocumentProviderLike<TUri> = {
  createBeforeUri(itemId: string): TUri;
  createCurrentUri(itemId: string): TUri;
};

export type ReviewDiffItemLike = {
  id: string;
};

export function createReviewDiffTargets<TUri>(
  documentProvider: ReviewDiffDocumentProviderLike<TUri>,
  item: ReviewDiffItemLike,
) {
  return {
    beforeUri: documentProvider.createBeforeUri(item.id),
    currentUri: documentProvider.createCurrentUri(item.id),
  };
}
