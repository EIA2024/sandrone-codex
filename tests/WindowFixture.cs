using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using NativeWindow=SandroneCodex.NativeWindow;
class Fixture : Form {
 protected override CreateParams CreateParams {get {var p=base.CreateParams;p.ExStyle|=0x08000000;return p;}}
 [STAThread]static void Main(string[] args){
  var form=new Fixture{Text="Sandrone window restore fixture",Width=640,Height=400,Opacity=0,ShowInTaskbar=false,WindowState=FormWindowState.Minimized};
  var timer=new Timer{Interval=300};bool before=false;int phase=0;uint pid=(uint)Process.GetCurrentProcess().Id;
  timer.Tick+=(s,e)=>{if(phase++==0){before=NativeWindow.IsMinimized(pid);NativeWindow.Activate(pid,false);}else{bool pass=before&&!NativeWindow.IsMinimized(pid);File.WriteAllText(args[0],pass?"PASS: own invisible minimized fixture restored":"FAIL: own fixture restore");timer.Stop();form.Close();Environment.ExitCode=pass?0:1;}};
  form.Shown+=(s,e)=>timer.Start();Application.Run(form);
 }
}
