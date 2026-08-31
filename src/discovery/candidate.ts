/** Canonical candidate shape emitted by discovery and consumed by normalization. */
export interface RawCandidate {
  name: string;
  category: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  websiteUrl: string | null;
  listingUrl: string;
  placeId: string | null;
  rating: number | null;
  reviewCount: number | null;
  lat: number | null;
  lng: number | null;
  rawObjectKey: string;
  query: string;
}
