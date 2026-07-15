import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "图名匠｜本地批量命名工具",
  description: "本地批量整理、统一命名并打包照片的小工具。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
