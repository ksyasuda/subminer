# Maintainer: sudacode <sudacode@example.com>
pkgname=mpv-yomitan
pkgver=1.0.0
pkgrel=1
pkgdesc="MPV subtitle overlay with Yomitan dictionary lookup support"
arch=('x86_64')
url="https://github.com/sudacode/mpv-yomitan"
license=('GPL-3.0-or-later')
depends=(
    'mpv'
    'mecab'
    'mecab-ipadic'
    'fuse2'
)
optdepends=(
    'fzf: Terminal-based video file picker'
    'rofi: GUI-based video file picker'
    'chafa: Video thumbnail previews in fzf'
    'ffmpegthumbnailer: Generate video thumbnails'
)
source=(
    "$pkgname-$pkgver.AppImage::$url/releases/download/v$pkgver/mpv-yomitan-$pkgver.AppImage"
    "ympv-$pkgver::$url/releases/download/v$pkgver/ympv"
    "catppuccin-macchiato.rasi::$url/raw/v$pkgver/catppuccin-macchiato.rasi"
)
sha256sums=('SKIP' 'SKIP' 'SKIP')

package() {
    install -Dm755 "$pkgname-$pkgver.AppImage" "$pkgdir/opt/$pkgname/mpv-yomitan.AppImage"
    install -Dm755 "ympv-$pkgver" "$pkgdir/usr/bin/ympv"
    install -Dm644 catppuccin-macchiato.rasi "$pkgdir/opt/$pkgname/catppuccin-macchiato.rasi"

    install -d "$pkgdir/usr/bin"
    ln -s "/opt/$pkgname/mpv-yomitan.AppImage" "$pkgdir/usr/bin/mpv-yomitan"
}
