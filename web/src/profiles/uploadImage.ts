import type { AssetDto } from '../../../shared/types.ts';
import { api } from '../api.ts';

/** Uploads a diagram background straight to storage and returns it once it is complete. */
export async function uploadImage(file: File): Promise<AssetDto> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This file is not an image the browser can read');
  });
  const { width, height } = bitmap;
  bitmap.close();

  const { asset, uploadUrl } = await api<{ asset: AssetDto; uploadUrl: string }>('/assets', {
    body: { contentType: file.type, size: file.size, width, height },
  });
  const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
  if (!res.ok) throw new Error(`Image upload failed (HTTP ${res.status})`);
  return (await api<{ asset: AssetDto }>(`/assets/${asset.id}/complete`, { method: 'POST' })).asset;
}
