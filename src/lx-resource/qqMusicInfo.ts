/** 将 QQ 歌曲详情转换为洛雪 tx 脚本接收的 musicInfo。 */
export function mapQQMusicInfo(song: any): Record<string, unknown> {
  const file = song.file || {};
  const sizes: Record<string, number> = {
    '128k': Number(file.size_128mp3) || 0,
    '320k': Number(file.size_320mp3) || 0,
    flac: Number(file.size_flac) || 0,
    flac24bit: Number(file.size_hires) || 0
  };
  const types = Object.entries(sizes).filter(([, size]) => size > 0).map(([type, bytes]) => ({
    type, size: `${(bytes / 1024 / 1024).toFixed(2)} MB`
  }));
  const seconds = Math.floor((Number(song.dt) || 0) / 1000);
  const mediaMid = String(file.media_mid || file.mediaMid || '');
  return {
    id: String(song.mid),
    songmid: String(song.mid),
    songId: song.id,
    ...(mediaMid ? { strMediaMid: mediaMid, mediaMid } : {}),
    source: 'tx',
    name: song.name || '',
    singer: (song.ar || []).map((artist: any) => artist.name).filter(Boolean).join('、'),
    albumName: song.al?.name || '',
    albumId: song.al?.mid || '',
    albumMid: song.al?.mid || '',
    interval: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
    img: song.al?.picUrl || '',
    types,
    _types: Object.fromEntries(types.map(({ type, size }) => [type, { size }])),
    typeUrl: {}
  };
}
