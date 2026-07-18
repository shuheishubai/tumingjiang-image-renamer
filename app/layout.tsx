import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "片刻｜本地图片工具",
  description: "在浏览器本地完成改名、裁剪、调色、压缩和人物抠图。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
