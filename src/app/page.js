"use client";

import { useState, useEffect } from "react";
import { processSettlementFile, fetchClaims } from "@/actions/upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { UploadCloud } from "lucide-react";

export default function Dashboard() {
  const [file, setFile] = useState(null);
  const [merchantName, setMerchantName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [claims, setClaims] = useState([]);

  useEffect(() => {
    loadClaims(merchantName);
  }, []);

  const loadClaims = async (name) => {
    const data = await fetchClaims(name);
    setClaims(data);
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!file || !merchantName) {
      toast.error("Please provide a Merchant Name and a File.");
      return;
    }
    
    setIsLoading(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("merchantName", merchantName);

    const result = await processSettlementFile(formData);
    if (result.success) {
      toast.success(`Successfully uploaded! Added: ${result.added}, Skipped (Duplicates): ${result.skipped}`);
      loadClaims(merchantName);
    } else {
      toast.error(result.error || "Failed to upload.");
    }
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100 p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Settlement Reconciler</h1>
          <p className="text-zinc-400 mt-2">Upload your Settlement Data CSV or Excel to parse and store fully reimbursed claims.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <Card className="col-span-1 bg-zinc-950 border-zinc-800 text-zinc-100 h-fit">
            <CardHeader>
              <CardTitle>Import Settlement</CardTitle>
              <CardDescription className="text-zinc-400">Match against existing data automatically based on WFSReferenceID.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleUpload} className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="merchant">Merchant Name</Label>
                  <Input 
                    id="merchant" 
                    placeholder="e.g. MyShop_Global" 
                    className="bg-zinc-900 border-zinc-700"
                    value={merchantName}
                    onChange={(e) => setMerchantName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="file">Settlement Data File</Label>
                  <div className="border-2 border-dashed border-zinc-700 rounded-lg p-6 flex flex-col items-center justify-center text-center hover:bg-zinc-900 transition relative">
                    <UploadCloud className="h-10 w-10 text-zinc-400 mb-4" />
                    <span className="text-sm text-zinc-400">
                      {file ? file.name : "Click or drag to upload"}
                    </span>
                    <Input 
                      id="file" 
                      type="file" 
                      accept=".xlsx, .xls, .csv"
                      className="absolute inset-0 opacity-0 cursor-pointer"
                      onChange={(e) => setFile(e.target.files[0])}
                    />
                  </div>
                </div>
                <Button type="submit" disabled={isLoading} className="w-full">
                  {isLoading ? "Processing..." : "Upload & Reconcile"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card className="col-span-1 md:col-span-2 bg-zinc-950 border-zinc-800 text-zinc-100">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Recent Claims Data</CardTitle>
                <CardDescription className="text-zinc-400">
                  Showing cross-matched claims {merchantName ? `for ${merchantName}` : 'across all merchants'}.
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => loadClaims(merchantName)} className="bg-zinc-900 text-white border-zinc-700">Refresh</Button>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto rounded-md border border-zinc-800">
                <Table>
                  <TableHeader className="bg-zinc-900">
                    <TableRow className="border-zinc-800 hover:bg-zinc-900/50">
                      <TableHead className="text-zinc-400">Merchant</TableHead>
                      <TableHead className="text-zinc-400">Transaction Date</TableHead>
                      <TableHead className="text-zinc-400">Ref ID</TableHead>
                      <TableHead className="text-zinc-400">Type</TableHead>
                      <TableHead className="text-zinc-400">Reason</TableHead>
                      <TableHead className="text-zinc-400 text-right">Net Payable</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {claims.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center h-48 text-zinc-500">
                          No claims found. Upload a settlement file to begin.
                        </TableCell>
                      </TableRow>
                    ) : (
                      claims.map((c) => (
                        <TableRow key={c.id} className="border-zinc-800 hover:bg-zinc-900/50">
                          <TableCell className="font-medium">{c.merchantName}</TableCell>
                          <TableCell>{new Date(c.transactionDateTime).toLocaleDateString()}</TableCell>
                          <TableCell className="font-mono text-xs">{c.wfsReferenceId}</TableCell>
                          <TableCell>
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              {c.transactionType}
                            </span>
                          </TableCell>
                          <TableCell>{c.reasonCode || "-"}</TableCell>
                          <TableCell className="text-right text-emerald-400">
                            ${c.netPayable.toFixed(2)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
