export default {
  giftPerpage: 20,
  defaultCardBackground: 'https://res.cloudinary.com/haymzm4wp/image/upload/v1689879547/assets/img/jkt48pt_vbvdpw.png',
  giftUrl: (id: string | number, type: GiftSize = 'small') => `https://static.showroom-live.com/image/gift/${id}_${type === 'small' ? 's' : 'm'}.png`,
  avatarURL: (id: number | string) => `https://static.showroom-live.com/image/avatar/${id}.png`,
  profileURL: (roomId: number | string) => `https://www.showroom-live.com/room/profile?room_id=${roomId}`,
  liveURL: (key: string) => `https://www.showroom-live.com/r${key?.startsWith('/') ? '' : '/'}${key}`,
  followURL: 'https://www.showroom-live.com/follow',
  tweetURL: (text: string) => `https://twitter.com/intent/tweet?text=${text}`,
  errorPicture: 'https://res.cloudinary.com/haymzm4wp/image/upload/v1674294578/assets/img/image-notfound_wsaxhy.jpg',
  fansProfileURL: (userId: string | number) => `https://www.showroom-live.com/user/profile?user_id=${userId}`,
  cloudinaryURL: 'https://res.cloudinary.com/haymzm4wp/image/upload',
  screenshotURL: (folder: string, id: string, format: string) => `https://res.cloudinary.com/haymzm4wp/image/upload/${folder?.startsWith('/') ? '' : '/'}${folder}/${id}.${format}`,
  getGroup(group: string | null) {
    return (group == null) ? 'jkt48' : ['jkt48', 'hinatazaka46'].includes(String(group)) ? String(group) : null
  },
  isSort(s: string | undefined | null): s is SortType {
    const sort: string[] = ['date', 'gift', 'views', 'duration']
    if (!s) return false
    return sort.includes(s)
  },
  uploadFolder: 'uploads',
}
