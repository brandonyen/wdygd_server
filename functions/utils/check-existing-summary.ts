import { getSupabase } from "./get-supabase-client";

export async function checkExistingSummary(
  user_id: string,
  start_date: string,
  end_date: string,
  summary_type: string,
) {
  const supabase = await getSupabase();

  const { data: existingSummaries, error } = await (
    supabase.from("Summary") as any
  )
    .select("*")
    .eq("user_id", user_id)
    .eq("start_date", start_date)
    .eq("end_date", end_date)
    .eq("summary_type", summary_type);

  if (error) {
    console.error(`Error checking for existing summary: ${error.message}`);
    return null;
  }

  if (existingSummaries && existingSummaries.length > 0) {
    return existingSummaries[0];
  }

  return null;
}
