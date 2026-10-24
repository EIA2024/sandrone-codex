using System;
using System.Runtime.InteropServices;
using System.Net;
namespace SandroneCodex {
 public static class NativeWindow {
  delegate bool EnumProc(IntPtr window,IntPtr data);
  [StructLayout(LayoutKind.Sequential)]struct Rect {public int Left,Top,Right,Bottom;}
  [DllImport("user32.dll")]static extern bool EnumWindows(EnumProc callback,IntPtr data);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll")]static extern bool ShowWindowAsync(IntPtr window,int command);
  [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("iphlpapi.dll")]static extern uint GetExtendedTcpTable(IntPtr table,ref int size,bool order,int family,int tableClass,uint reserved);
  // Query the OS table directly; avoid spinning up CIM for every startup poll.
  // IPv4 AND IPv6 are inspected, including wildcard listeners and foreign PIDs.
  static bool InspectPort(int port,uint owner,bool requireOwner,out bool found){
   found=false;
   foreach(int family in new[]{2,23}){
    int size=0;uint error=GetExtendedTcpTable(IntPtr.Zero,ref size,false,family,3,0);
    if(error!=0&&error!=122)throw new InvalidOperationException("TCP ownership query failed");
    if(size<4||size>16000000)throw new InvalidOperationException("Invalid TCP table size");
    IntPtr memory=Marshal.AllocHGlobal(size);
    try{
     error=GetExtendedTcpTable(memory,ref size,false,family,3,0);
     if(error!=0)throw new InvalidOperationException("TCP ownership query failed");
     int count=Marshal.ReadInt32(memory),stride=family==2?24:56;
     if(count<0||4L+(long)count*stride>size)throw new InvalidOperationException("Invalid TCP rows");
     for(int i=0;i<count;i++){
      IntPtr row=IntPtr.Add(memory,4+i*stride);int raw=Marshal.ReadInt32(row,family==2?8:20);
      int rowPort=((raw&255)<<8)|((raw>>8)&255);if(rowPort!=port)continue;
      found=true;if(!requireOwner)continue;
      uint pid=unchecked((uint)Marshal.ReadInt32(row,family==2?20:52));
      byte[] bytes=new byte[family==2?4:16];Marshal.Copy(IntPtr.Add(row,family==2?4:0),bytes,0,bytes.Length);
      IPAddress address=new IPAddress(bytes);
      if(pid!=owner||!(address.Equals(IPAddress.Loopback)||address.Equals(IPAddress.IPv6Loopback)))return false;
     }
    }finally{Marshal.FreeHGlobal(memory);}
   }
   return true;
  }
  public static bool OwnsLoopbackListener(int port,uint owner){bool found;return InspectPort(port,owner,true,out found)&&found;}
  public static bool HasListener(int port){bool found;InspectPort(port,0,false,out found);return found;}
  static IntPtr Find(uint owner){
   IntPtr selected=IntPtr.Zero;long best=-1;
   EnumWindows((window,data)=>{
    uint pid;GetWindowThreadProcessId(window,out pid);
    if(pid!=owner||GetWindowTextLength(window)==0)return true;
    Rect r;if(!GetWindowRect(window,out r))return true;
    bool minimized=IsIconic(window);long width=r.Right-r.Left,height=r.Bottom-r.Top;
    if(!minimized&&(width<320||height<180))return true;
    long score=(minimized?200000000L:IsWindowVisible(window)?100000000L:0)+Math.Max(0,width*height);
    if(score>best){selected=window;best=score;}return true;
   },IntPtr.Zero);
   return selected;
  }
  // Caller verifies executable, start time and local browser ownership first.
  public static bool Activate(uint owner,bool foreground){
   IntPtr window=Find(owner);if(window==IntPtr.Zero)return false;
   if(IsIconic(window))ShowWindowAsync(window,9);
   else if(!IsWindowVisible(window))ShowWindowAsync(window,5);
   if(foreground)SetForegroundWindow(window);
   return true;
  }
  public static bool IsMinimized(uint owner){IntPtr window=Find(owner);return window!=IntPtr.Zero&&IsIconic(window);}
 }
}
