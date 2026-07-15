import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "图名匠｜个人照片命名工具",
  description: "每个人都能独立使用的本地照片命名工具。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
